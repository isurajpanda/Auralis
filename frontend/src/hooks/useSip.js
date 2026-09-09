import { useEffect, useRef, useState, useCallback } from 'react'
import { SIGNAL_WS, RISK_WS } from '../lib/config.js'

const NO_ANSWER_MS = 30000
const UPLOAD_SECONDS = 2 // backend scores one chunk per 2s of 16kHz mono PCM
const UPLOAD_RATE = 16000

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
  const [uploadedChunks, setUploadedChunks] = useState(0) // mic chunks scored by backend
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
    try { st.node.port.close() } catch {}
    try { st.src.disconnect() } catch {}
    try { st.node.disconnect() } catch {}
    try { st.ctx.close() } catch {}
    try { URL.revokeObjectURL(st.url) } catch {}
    try { st.ws.close() } catch {}
    setUploadedChunks(0)
  }, [])

  const doHangupLocal = () => {
    clearNoAnswerTimer()
    stopMicUpload()
    try { pcRef.current?.close() } catch {}
    pcRef.current = null
    pendingOfferRef.current = null
    // tear down volume tap
    try { volSourceRef.current?.disconnect() } catch {}
    volSourceRef.current = null
    volAnalyserRef.current = null
    volSmoothRef.current = 0
    setRemoteLevel(0)
    setCallState({ inCall: false, incoming: null, status: 'ready' })
  }

  const sendHangup = (target, reason) => {
    try {
      if (target && wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({ type: 'hangup', target, reason }))
      }
    } catch {}
  }

  const connectSignaling = useCallback(() => {
    if (!myNumber) return
    const ws = new WebSocket(SIGNAL_WS(myNumber))
    wsRef.current = ws
    ws.onopen = () => { setRegistered(true); setCallState({ status: 'ready' }) }
    ws.onclose = () => { setRegistered(false); setCallState({ status: 'idle', incoming: null }) }
    ws.onerror = () => setCallState({ status: 'error' })
    ws.onmessage = async (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      const st = stateRef.current
      if (msg.type === 'offer') {
        // Busy: already in a call, dialling out, or ringing — reject cleanly.
        if (st.inCall || st.status === 'calling' || st.incoming) {
          try {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'hangup', target: msg.from, reason: 'busy' }))
          } catch {}
          return
        }
        pendingOfferRef.current = msg
        setCallState({ incoming: { from: msg.from, sdp: msg.sdp }, status: 'ringing' })
      } else if (msg.type === 'answer') {
        if (!pcRef.current) return
        clearNoAnswerTimer()
        try { await pcRef.current.setRemoteDescription(new RTCSessionDescription(msg.sdp)) } catch {}
        setCallState({ inCall: true, status: 'in-call' })
        eventsRef.current?.onConnected?.()
      } else if (msg.type === 'ice') {
        try { await pcRef.current?.addIceCandidate(msg.candidate) } catch {}
      } else if (msg.type === 'hangup') {
        const reason = msg.reason || 'ended'
        const from = msg.from
        if (st.incoming && !st.inCall) {
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
    if (localStreamRef.current) return localStreamRef.current
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
      console.warn('[mic] raw constraints rejected, using default mic', err)
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    }
    localStreamRef.current = stream
    return stream
  }

  const createPC = (target, onFailed) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    pc.onicecandidate = (e) => {
      if (e.candidate && wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({ type: 'ice', target, candidate: e.candidate }))
      }
    }
    pc.ontrack = (e) => {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = e.streams[0]
        remoteAudioRef.current.play().catch(() => {})
      }
      setupVolumeTap(e.streams[0])
    }
    pc.onconnectionstatechange = () => {
      // PeerConnection died mid-call -> treat as remote hangup so both
      // sides leave the call screen together.
      if (pc.connectionState === 'failed' && pcRef.current === pc) {
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
    const buf = new Uint8Array(256)
    const t = setInterval(() => {
      const an = volAnalyserRef.current
      if (!an) return
      try {
        an.getByteTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / buf.length)
        const target = Math.min(1, rms * 2.4)
        const prev = volSmoothRef.current
        // fast attack, slow release so the line feels alive
        const next = target > prev ? target : prev * 0.82 + target * 0.18
        volSmoothRef.current = next
        setRemoteLevel(next)
      } catch {}
    }, 100)
    return () => clearInterval(t)
  }, [])

  // Streams local mic audio to the backend risk WS as 2s int16/16kHz chunks.
  // Backend scores each chunk and broadcasts risk_update on the same session.
  const startMicUpload = useCallback(async (sessionId) => {
    if (!sessionId || uploadRef.current) return
    try {
      const stream = await getLocalStream()
      const ws = new WebSocket(RISK_WS(sessionId))
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) { try { ws.close() } catch {} return }
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
            ws.send(JSON.stringify({
              type: 'audio_chunk',
              pcm_b64: int16ToB64(ds),
              chunk_index: st.idx,
              sample_rate: UPLOAD_RATE,
            }))
            st.idx += 1
            setUploadedChunks(st.idx)
          } catch {}
        }
      }
      src.connect(node)
      uploadRef.current = st
    } catch (err) {
      console.warn('[mic-upload] failed', err)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const acceptIncoming = async () => {
    const msg = pendingOfferRef.current
    if (!msg) return null
    const stream = await getLocalStream()
    stream.getTracks().forEach((t) => { t.enabled = !muted })
    const pc = createPC(msg.from)
    stream.getTracks().forEach((t) => pc.addTrack(t, stream))
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    try { wsRef.current.send(JSON.stringify({ type: 'answer', target: msg.from, sdp: answer })) } catch {}
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
    if (!myNumber) return
    const stream = await getLocalStream()
    stream.getTracks().forEach((t) => { t.enabled = !muted })
    const pc = createPC(target)
    stream.getTracks().forEach((t) => pc.addTrack(t, stream))
    const offer = await pc.createOffer({ offerToReceiveAudio: true })
    await pc.setLocalDescription(offer)
    try {
      wsRef.current.send(JSON.stringify({ type: 'offer', target, sdp: offer, call_id: `${myNumber}-${target}-${Date.now()}` }))
    } catch {}
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
    setMuted(next)
    localStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = !next })
  }

  const toggleSpeaker = () => setSpeaker((s) => !s)

  return {
    registered, inCall, status, remoteLevel, uploadedChunks,
    incoming, acceptIncoming, rejectIncoming,
    call, hangup, startMicUpload, stopMicUpload,
    muted, toggleMute, speaker, toggleSpeaker,
    remoteAudioRef,
  }
}
