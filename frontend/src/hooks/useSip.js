import { useEffect, useRef, useState, useCallback } from 'react'
import { SIGNAL_WS, RISK_WS } from '../lib/config.js'

const NO_ANSWER_MS = 30000
const UPLOAD_SECONDS = 2 // backend scores one chunk per 2s of 16kHz mono PCM
const UPLOAD_RATE = 16000

// Timestamped ring-buffer log for audio debugging. Everything voice-related
// goes through `alog()` so a broken call leaves a trail in DevTools, and
// `window.__auralisAudio()` dumps state + recent lines for remote diagnosis.
const ALOG_MAX = 200
const alogBuf = []
function alog(level, ...args) {
  const line = `${new Date().toISOString()} [sip:${level}] ${args.map((a) => {
    try { return typeof a === 'string' ? a : JSON.stringify(a) } catch { return String(a) }
  }).join(' ')}`
  alogBuf.push(line)
  if (alogBuf.length > ALOG_MAX) alogBuf.shift()
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(line)
}
const slog = (...a) => alog('info', ...a)
if (typeof window !== 'undefined') {
  window.__auralisAudio = () => ({
    snapshot: window.__auralisAudioSnap?.() ?? null,
    log: [...alogBuf],
  })
}

// AudioWorklet ships mic frames (~128 samples each) to the main thread,
// where they are downsampled to 16kHz and buffered into 2s chunks.
const MIC_WORKLET_CODE = `
class MicChunker extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs && inputs[0] && inputs[0][0]
    if (ch && ch.length) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('mic-chunker', MicChunker)
`

function downsampleTo16k(data, fromRate) {
  if (fromRate === UPLOAD_RATE) return Float32Array.from(data)
  const ratio = fromRate / UPLOAD_RATE
  const outLen = Math.floor(data.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(data.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j++) sum += data[j]
    out[i] = sum / Math.max(1, end - start)
  }
  return out
}

function int16ToB64(samples) {
  const i16 = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const bytes = new Uint8Array(i16.buffer)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

/**
 * Simple WebRTC signaling hook (backend /ws/signal/{ext}).
 * Phone-style: exposes incoming call instead of window.confirm().
 *
 * events: {
 *   onConnected()              — peer answered (outgoing) / we answered
 *   onRemoteHangup(reason, from) — peer ended an active/outgoing call
 *   onMissedCall(from)          — peer cancelled while we were ringing
 *   onNoAnswer()                — outgoing call rang out with no answer
 *   onMediaFailed(kind)         — mic unavailable ('mic') or signaling down
 *                                 ('signal') before any audio could flow
 * }
 * Hangup reasons: 'ended' | 'declined' | 'busy' | 'cancelled' | 'failed'
 */
export function useSip(myNumber, events) {
  const [registered, setRegistered] = useState(false)
  const [inCall, setInCall] = useState(false)
  const [status, setStatus] = useState('idle') // idle | ready | calling | in-call | ringing | error
  const [incoming, setIncoming] = useState(null) // { from, sdp }
  const [muted, setMuted] = useState(false)
  const [speaker, setSpeaker] = useState(true)
  const [remoteLevel, setRemoteLevel] = useState(0) // 0..1 incoming voice volume
  const [peerHeard, setPeerHeard] = useState(false) // true once remote audio visibly flows
  const [uploadedChunks, setUploadedChunks] = useState(0) // mic chunks scored by backend
  const peerHeardRef = useRef(false)
  const pendingIceRef = useRef([]) // candidates arriving before setRemoteDescription
  const mutedRef = useRef(false)
  mutedRef.current = muted
  const uploadRef = useRef(null) // { ws, ctx, src, node, url, buf, idx }
  const wsRef = useRef(null)
  const pcRef = useRef(null)
  const localStreamRef = useRef(null)
  const remoteAudioRef = useRef(null)
  const pendingOfferRef = useRef(null)
  const noAnswerTimerRef = useRef(null)
  // volume analyser chain (taps remote stream pre-element so mute doesn't lie)
  const volCtxRef = useRef(null)
  const volAnalyserRef = useRef(null)
  const volSourceRef = useRef(null)
  const volSmoothRef = useRef(0)
  const eventsRef = useRef(events)
  eventsRef.current = events
  // mirrors for use inside the (long-lived) ws message handler
  const stateRef = useRef({ inCall: false, status: 'idle', incoming: null })
  const setCallState = (patch) => {
    Object.assign(stateRef.current, patch)
    if (patch.inCall !== undefined) setInCall(patch.inCall)
    if (patch.status !== undefined) setStatus(patch.status)
    if (patch.incoming !== undefined) setIncoming(patch.incoming)
  }

  const clearNoAnswerTimer = () => {
    if (noAnswerTimerRef.current) { clearTimeout(noAnswerTimerRef.current); noAnswerTimerRef.current = null }
  }

  const stopMicUpload = useCallback(() => {
    const st = uploadRef.current
    uploadRef.current = null
    if (!st) return
    slog('mic-upload stop, chunks sent=', st.idx)
    try { st.node.port.close() } catch {}
    try { st.src.disconnect() } catch {}
    try { st.node.disconnect() } catch {}
    try { st.ctx.close() } catch {}
    try { URL.revokeObjectURL(st.url) } catch {}
    try { st.ws.close() } catch {}
    setUploadedChunks(0)
  }, [])

  const markPeerHeard = () => {
    if (!peerHeardRef.current) {
      peerHeardRef.current = true
      setPeerHeard(true)
      slog('peer audio flowing (remote level crossed threshold)')
    }
  }

  const doHangupLocal = () => {
    clearNoAnswerTimer()
    stopMicUpload()
    try { pcRef.current?.close() } catch {}
    pcRef.current = null
    pendingOfferRef.current = null
    pendingIceRef.current = []
    peerHeardRef.current = false
    setPeerHeard(false)
    // tear down volume tap
    try { volSourceRef.current?.disconnect() } catch {}
    volSourceRef.current = null
    volAnalyserRef.current = null
    volSmoothRef.current = 0
    setRemoteLevel(0)
    setCallState({ inCall: false, incoming: null, status: 'ready' })
  }

  // Drain candidates that arrived before setRemoteDescription. Without this,
  // early (often host) candidates are dropped and the call can stay silent.
  const flushPendingIce = async () => {
    const pc = pcRef.current
    const q = pendingIceRef.current
    pendingIceRef.current = []
    for (const c of q) {
      try { await pc?.addIceCandidate(c) } catch (err) { alog('warn', 'flush ice failed', err?.message) }
    }
    if (q.length) slog('flushed', q.length, 'queued ice candidates')
  };

  const sendHangup = (target, reason) => {
    try {
      if (target && wsRef.current?.readyState === 1) {
        slog('send hangup to', target, 'reason=', reason)
        wsRef.current.send(JSON.stringify({ type: 'hangup', target, reason }))
      } else if (target) {
        alog('warn', 'hangup to', target, 'not sent (socket not open)')
      }
    } catch (err) { alog('error', 'sendHangup failed', err?.message) }
  }

  const connectSignaling = useCallback(() => {
    if (!myNumber) return
    const ws = new WebSocket(SIGNAL_WS(myNumber))
    wsRef.current = ws
    ws.onopen = () => { slog('signal open as', myNumber); setRegistered(true); setCallState({ status: 'ready' }) }
    ws.onclose = (e) => { alog('warn', 'signal closed as', myNumber, 'code=', e.code, 'reason=', e.reason); setRegistered(false); setCallState({ status: 'idle', incoming: null }) }
    ws.onerror = () => { alog('error', 'signal error as', myNumber); setCallState({ status: 'error' }) }
    ws.onmessage = async (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      const st = stateRef.current
      if (msg.type === 'offer') {
        slog('recv offer from', msg.from)
        // Busy: already in a call, dialling out, or ringing — reject cleanly.
        if (st.inCall || st.status === 'calling' || st.incoming) {
          slog('busy, rejecting offer from', msg.from)
          try {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'hangup', target: msg.from, reason: 'busy' }))
          } catch {}
          return
        }
        pendingOfferRef.current = msg
        setCallState({ incoming: { from: msg.from, sdp: msg.sdp }, status: 'ringing' })
      } else if (msg.type === 'answer') {
        slog('recv answer from', msg.from)
        if (!pcRef.current) { alog('warn', 'answer with no peerconnection, ignoring'); return }
        clearNoAnswerTimer()
        try { await pcRef.current.setRemoteDescription(new RTCSessionDescription(msg.sdp)) }
        catch (err) { alog('error', 'setRemoteDescription(answer) failed', err?.message); return }
        await flushPendingIce()
        setCallState({ inCall: true, status: 'in-call' })
        eventsRef.current?.onConnected?.()
      } else if (msg.type === 'ice') {
        if (!msg.candidate) return
        if (!pcRef.current || !pcRef.current.remoteDescription) {
          pendingIceRef.current.push(msg.candidate) // remote not set yet — queue
          return
        }
        try { await pcRef.current?.addIceCandidate(msg.candidate) }
        catch (err) { alog('warn', 'addIceCandidate failed', err?.message) }
      } else if (msg.type === 'hangup') {
        const reason = msg.reason || 'ended'
        const from = msg.from
        slog('recv hangup from', from, 'reason=', reason)
        if (reason === 'answered-elsewhere' && st.incoming && !st.inCall) {
          // Another tab of ours answered — stand down silently (no
          // missed-call event, no tone; the call continues elsewhere).
          pendingOfferRef.current = null
          doHangupLocal()
        } else if (st.incoming && !st.inCall) {
          // Caller cancelled (or a stray hangup) while we were ringing.
          doHangupLocal()
          eventsRef.current?.onMissedCall?.(from)
        } else if (st.inCall || st.status === 'calling') {
          doHangupLocal()
          eventsRef.current?.onRemoteHangup?.(reason, from)
        }
        // else: idle — ignore stray hangup
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myNumber])

  useEffect(() => {
    if (!myNumber) { setRegistered(false); return }
    connectSignaling()
    return () => {
      clearNoAnswerTimer()
      stopMicUpload()
      try { pcRef.current?.close() } catch {}
      pcRef.current = null
      try { wsRef.current?.close() } catch {}
    }
  }, [myNumber, connectSignaling, stopMicUpload])

  // speaker toggle -> remote audio element muted
  useEffect(() => {
    if (remoteAudioRef.current) remoteAudioRef.current.muted = !speaker
  }, [speaker])

  const getLocalStream = async () => {
    if (localStreamRef.current) {
      const live = localStreamRef.current.getAudioTracks().map((t) => `${t.label}:${t.readyState}`).join(',')
      slog('reusing mic stream', live || '(no tracks!)')
      return localStreamRef.current
    }
    // RAW mic on purpose: echoCancellation / noiseSuppression / autoGainControl
    // all destroy exactly the spectral artifacts spoof detection needs, and
    // echoCancellation would erase audio played back on this same device
    // (e.g. testing with an ElevenLabs clip out of your speakers).
    // If a device rejects raw constraints, fall back to the default mic.
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      })
    } catch (err) {
      alog('warn', 'raw mic constraints rejected, using default mic', err?.message)
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    }
    const tracks = stream.getAudioTracks().map((t) => `${t.label || '?'}:${t.readyState}:enabled=${t.enabled}`).join(',')
    slog('mic stream ready:', tracks || '(NO AUDIO TRACKS)')
    if (!stream.getAudioTracks().length) throw new Error('no audio tracks in mic stream')
    localStreamRef.current = stream
    return stream
  }

  const createPC = (target, onFailed) => {
    // Two STUN servers so phones/laptops on different APs/NATs across
    // the LAN can still gather server-reflexive candidates.
    const pc = new RTCPeerConnection({ iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ] })
    pc.onicecandidate = (e) => {
      if (e.candidate && wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({ type: 'ice', target, candidate: e.candidate }))
      } else if (e.candidate) {
        alog('warn', 'dropping local ice (socket not open)')
      } else {
        slog('ice gathering complete for', target)
      }
    }
    pc.ontrack = (e) => {
      // e.streams[0] can be missing on transceiver-only implementations —
      // fall back to an explicit MediaStream so we never go silent quietly.
      const stream = (e.streams && e.streams[0]) || new MediaStream([e.track])
      const t = e.track
      slog('ontrack:', t.kind, 'state=', t.readyState, 'muted=', t.muted, 'id=', t.id)
      t.onended = () => alog('warn', 'remote track ended')
      t.onmute = () => slog('remote track muted')
      t.onunmute = () => slog('remote track unmuted')
      try {
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = stream
          remoteAudioRef.current.play()
            .then(() => slog('remote audio element playing'))
            .catch((err) => alog('error', 'remote audio play() blocked:', err?.message, '— tap the page, then re-answer'))
        } else {
          alog('error', 'ontrack but remoteAudioRef is null — nowhere to play audio!')
        }
      } catch (err) { alog('error', 'ontrack attach failed', err?.message) }
      setupVolumeTap(stream)
    }
    pc.onconnectionstatechange = () => {
      slog('pc connectionState ->', pc.connectionState, 'ice=', pc.iceConnectionState, 'with', target)
      // PeerConnection died mid-call -> treat as remote hangup so both
      // sides leave the call screen together.
      if (pc.connectionState === 'failed' && pcRef.current === pc) {
        alog('error', 'peerconnection failed with', target)
        const wasLive = stateRef.current.inCall || stateRef.current.status === 'calling'
        doHangupLocal()
        if (wasLive) eventsRef.current?.onRemoteHangup?.('failed')
      }
    }
    pcRef.current = pc
    return pc
  }

  // Tap the incoming stream with an AnalyserNode for the volume meter.
  // Not connected to destination — the <audio> element already plays it.
  const setupVolumeTap = (stream) => {
    try {
      if (!volCtxRef.current) {
        const AC = window.AudioContext || window.webkitAudioContext
        if (!AC) return
        volCtxRef.current = new AC()
      }
      const ac = volCtxRef.current
      if (ac.state === 'suspended') ac.resume().catch(() => {})
      try { volSourceRef.current?.disconnect() } catch {}
      const src = ac.createMediaStreamSource(stream)
      const an = ac.createAnalyser()
      an.fftSize = 512
      an.smoothingTimeConstant = 0.4
      src.connect(an)
      volSourceRef.current = src
      volAnalyserRef.current = an
    } catch {}
  }

  // Poll analyser ~10x/s into smoothed 0..1 level for the UI meter.
  useEffect(() => {
    const t = setInterval(() => {
      const an = volAnalyserRef.current
      if (!an) return
      try {
        // buffer must match fftSize (time-domain length == fftSize)
        const buf = new Uint8Array(an.fftSize)
        an.getByteTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / buf.length)
        const target = Math.min(1, rms * 2.4)
        if (target > 0.05) markPeerHeard()
        const prev = volSmoothRef.current
        // fast attack, slow release so the line feels alive
        const next = target > prev ? target : prev * 0.82 + target * 0.18
        volSmoothRef.current = next
        setRemoteLevel(next)
      } catch (err) { alog('warn', 'volume poll failed', err?.message) }
    }, 100)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Streams local mic audio to the backend risk WS as 2s int16/16kHz chunks.
  // Backend scores each chunk and broadcasts risk_update on the same session.
  const startMicUpload = useCallback(async (sessionId) => {
    if (!sessionId || uploadRef.current) {
      if (uploadRef.current) slog('mic-upload already running, ignoring start')
      return
    }
    slog('mic-upload starting for session', sessionId?.slice?.(0, 8))
    try {
      const stream = await getLocalStream()
      const ws = new WebSocket(RISK_WS(sessionId))
      ws.onopen = () => slog('mic-upload socket open')
      ws.onerror = () => alog('error', 'mic-upload socket error — chunks cannot reach backend')
      ws.onclose = (e) => slog('mic-upload socket closed code=', e.code)
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) { alog('error', 'no AudioContext — mic upload impossible'); try { ws.close() } catch {} return }
      const actx = new AC()
      const unlock = () => { if (actx.state === 'suspended') actx.resume().catch(() => {}) }
      if (actx.state === 'suspended') {
        actx.resume().catch(() => {})
        window.addEventListener('pointerdown', unlock, { once: true })
        window.addEventListener('keydown', unlock, { once: true })
      }
      const src = actx.createMediaStreamSource(stream)
      const url = URL.createObjectURL(new Blob([MIC_WORKLET_CODE], { type: 'application/javascript' }))
      await actx.audioWorklet.addModule(url)
      const node = new AudioWorkletNode(actx, 'mic-chunker')
      const st = { ws, ctx: actx, src, node, url, buf: [], idx: 0, inRate: actx.sampleRate }
      node.port.onmessage = (e) => {
        const cur = uploadRef.current
        if (!cur || cur !== st || ws.readyState !== 1) return
        const frame = e.data
        if (!frame?.length) return
        for (let i = 0; i < frame.length; i++) st.buf.push(frame[i])
        const need = st.inRate * UPLOAD_SECONDS
        if (st.buf.length >= need) {
          const raw = st.buf.slice(0, need)
          st.buf = st.buf.slice(need)
          if (mutedRef.current) return // don't score silence while muted
          const ds = downsampleTo16k(raw, st.inRate)
          try {
            const b64len = Math.round(ds.length * 2 * 4 / 3)
            ws.send(JSON.stringify({
              type: 'audio_chunk',
              pcm_b64: int16ToB64(ds),
              chunk_index: st.idx,
              sample_rate: UPLOAD_RATE,
            }))
            st.idx += 1
            setUploadedChunks(st.idx)
            if (st.idx === 1 || st.idx % 10 === 0) slog(`mic-upload chunk #${st.idx} sent (~${b64len}b b64, ws=${ws.readyState})`)
          } catch (err) { alog('error', 'mic-upload send failed', err?.message) }
        }
      }
      src.connect(node)
      uploadRef.current = st
      slog('mic-upload worklet running, inputRate=', st.inRate)
    } catch (err) {
      alog('error', 'mic-upload failed', err?.message)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const acceptIncoming = async () => {
    const msg = pendingOfferRef.current
    if (!msg) { alog('warn', 'accept with no pending offer'); return null }
    slog('accepting call from', msg.from)
    let stream
    try {
      stream = await getLocalStream()
    } catch (err) {
      alog('error', 'mic unavailable on accept:', err?.message, '— declining')
      sendHangup(msg.from, 'failed')
      doHangupLocal()
      eventsRef.current?.onMediaFailed?.('mic')
      return null
    }
    stream.getTracks().forEach((t) => { t.enabled = !muted })
    const pc = createPC(msg.from)
    stream.getTracks().forEach((t) => pc.addTrack(t, stream))
    slog('local tracks added:', stream.getAudioTracks().length)
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
    } catch (err) { alog('error', 'setRemoteDescription(offer) failed', err?.message); return null }
    await flushPendingIce()
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    try {
      if (wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({ type: 'answer', target: msg.from, sdp: answer }))
        slog('sent answer to', msg.from)
      } else alog('error', 'cannot send answer — socket closed')
    } catch (err) { alog('error', 'send answer failed', err?.message) }
    pendingOfferRef.current = null
    setCallState({ incoming: null, inCall: true, status: 'in-call' })
    eventsRef.current?.onConnected?.()
    return msg.from
  }

  const rejectIncoming = () => {
    const msg = pendingOfferRef.current
    sendHangup(msg?.from, 'declined')
    doHangupLocal()
  }

  const call = async (target) => {
    if (!myNumber) { alog('warn', 'call with no identity'); return }
    if (wsRef.current?.readyState !== 1) {
      alog('error', 'call aborted — signaling socket not open (registered=false?)')
      eventsRef.current?.onMediaFailed?.('signal')
      return
    }
    slog('calling', target, 'as', myNumber)
    let stream
    try {
      stream = await getLocalStream()
    } catch (err) {
      alog('error', 'mic unavailable on call:', err?.message)
      eventsRef.current?.onMediaFailed?.('mic')
      throw err // App.startCall catches; screen already handles via event
    }
    stream.getTracks().forEach((t) => { t.enabled = !muted })
    const pc = createPC(target)
    stream.getTracks().forEach((t) => pc.addTrack(t, stream))
    slog('local tracks added:', stream.getAudioTracks().length)
    const offer = await pc.createOffer({ offerToReceiveAudio: true })
    await pc.setLocalDescription(offer)
    try {
      wsRef.current.send(JSON.stringify({ type: 'offer', target, sdp: offer, call_id: `${myNumber}-${target}-${Date.now()}` }))
      slog('sent offer to', target)
    } catch (err) { alog('error', 'send offer failed', err?.message); return }
    setCallState({ status: 'calling' })
    // No answer within timeout -> cancel both sides so nobody is stuck ringing.
    clearNoAnswerTimer()
    noAnswerTimerRef.current = setTimeout(() => {
      if (stateRef.current.status === 'calling' && !stateRef.current.inCall) {
        sendHangup(target, 'cancelled')
        doHangupLocal()
        eventsRef.current?.onNoAnswer?.()
      }
    }, NO_ANSWER_MS)
  }

  const hangup = (peer, reason = 'ended') => {
    sendHangup(peer, reason)
    doHangupLocal()
  }

  const toggleMute = () => {
    const next = !muted
    slog(next ? 'mic muted' : 'mic unmuted')
    setMuted(next)
    localStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = !next })
  }

  const toggleSpeaker = () => setSpeaker((s) => !s)

  // Live snapshot for window.__auralisAudio() remote diagnosis.
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.__auralisAudioSnap = () => ({
      me: myNumber, registered, inCall, status,
      incomingFrom: incoming?.from ?? null,
      muted, speaker, remoteLevel: +remoteLevel.toFixed(3),
      peerHeard, uploadedChunks,
      pc: pcRef.current ? {
        connection: pcRef.current.connectionState,
        ice: pcRef.current.iceConnectionState,
        signaling: pcRef.current.signalingState,
      } : null,
      localTracks: (localStreamRef.current?.getAudioTracks() ?? []).map((t) => `${t.label || '?'}:${t.readyState}:enabled=${t.enabled}`),
      remoteElement: remoteAudioRef.current ? {
        hasStream: !!remoteAudioRef.current.srcObject,
        paused: remoteAudioRef.current.paused,
        muted: remoteAudioRef.current.muted,
      } : null,
    })
  })

  return {
    registered, inCall, status, remoteLevel, peerHeard, uploadedChunks,
    incoming, acceptIncoming, rejectIncoming,
    call, hangup, startMicUpload, stopMicUpload,
    muted, toggleMute, speaker, toggleSpeaker,
    remoteAudioRef,
  }
}
