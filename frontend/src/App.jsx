import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useSip } from './hooks/useSip.js'
import { useRiskSocket } from './hooks/useRiskSocket.js'
import { BACKEND_HTTP } from './lib/config.js'
import { startRingback, stopRingback, startRinger, stopRinger, stopAll, playThreatBeep } from './lib/ringtones.js'

const IDENTITIES = [
  { ext: '1001', name: 'Alice' },
  { ext: '1002', name: 'Bob' },
  { ext: '1003', name: 'Carol' },
  { ext: '1004', name: 'Dave' },
  { ext: '1005', name: 'Eve' },
]

const KEYS = [
  { d: '1', s: '' }, { d: '2', s: 'ABC' }, { d: '3', s: 'DEF' },
  { d: '4', s: 'GHI' }, { d: '5', s: 'JKL' }, { d: '6', s: 'MNO' },
  { d: '7', s: 'PQRS' }, { d: '8', s: 'TUV' }, { d: '9', s: 'WXYZ' },
  { d: '*', s: '' }, { d: '0', s: '+' }, { d: '#', s: '' },
]

const LS_KEY = 'auralis-local-recents'

function fmtTime(sec) {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function riskMeta(level) {
  if (level === 'high') return { dot: '#ff4d5e', label: 'Suspicious voice', sub: 'Possible clone — consider hanging up', icon: 'bi-exclamation-triangle-fill' }
  if (level === 'medium') return { dot: '#ffb020', label: 'Unusual voice', sub: 'Stay cautious', icon: 'bi-shield-fill-check' }
  return { dot: '#2fd47e', label: 'Call secured', sub: 'Voice looks normal', icon: 'bi-shield-fill-check' }
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

export default function App() {
  const [myExt, setMyExt] = useState('1001')
  const [digits, setDigits] = useState('')
  const [tab, setTab] = useState('keypad') // keypad | recents (mobile only)
  const [screen, setScreen] = useState('dial') // dial | call
  const [peer, setPeer] = useState('')
  const [sessionId, setSessionId] = useState(null)
  const [callStart, setCallStart] = useState(null)
  const [elapsed, setElapsed] = useState(0)
  const [serverRecents, setServerRecents] = useState([])
  const [localRecents, setLocalRecents] = useState(loadLocal)
  const [lastCall, setLastCall] = useState(null) // { peer, duration, level, note }
  const [showIdentity, setShowIdentity] = useState(false)

  const peerRef = useRef('')
  const screenRef = useRef(screen)
  screenRef.current = screen
  // mirrors for event callbacks (remote hangup etc. fire outside render)
  const sessionIdRef = useRef(null)
  sessionIdRef.current = sessionId
  const levelRef = useRef('low')
  const callStartRef = useRef(null)
  const localRecentsRef = useRef(localRecents)
  localRecentsRef.current = localRecents

  const persistLocal = (arr) => {
    setLocalRecents(arr)
    try { localStorage.setItem(LS_KEY, JSON.stringify(arr.slice(0, 20))) } catch {}
  }

  // Shared teardown for local AND remote call ends — both sides leave the
  // call screen together, end their risk session, and log the call.
  const finishCall = useCallback(async (note) => {
    const p = peerRef.current
    const sid = sessionIdRef.current
    const started = callStartRef.current
    const dur = started ? Math.floor((Date.now() - started) / 1000) : 0
    const lvl = levelRef.current
    stopAll()
    if (sid) {
      try { await fetch(`${BACKEND_HTTP}/api/calls/${sid}/end`, { method: 'POST' }) } catch {}
    }
    setLastCall({ peer: p, duration: dur, level: lvl, note })
    if (p) {
      const next = [{ peer: p, startedAt: new Date().toISOString(), duration: dur, level: lvl, note }, ...localRecentsRef.current].slice(0, 20)
      persistLocal(next)
    }
    setSessionId(null)
    setCallStart(null)
    setScreen('dial')
    setDigits('')
    peerRef.current = ''
    loadRecents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const remoteNote = (reason) => {
    if (reason === 'declined') return 'Declined'
    if (reason === 'busy') return 'Busy'
    if (reason === 'failed') return 'Connection lost'
    return 'Ended by other side'
  }

  const { registered, inCall, status, remoteLevel, uploadedChunks, incoming, acceptIncoming, rejectIncoming, call, hangup, startMicUpload, stopMicUpload, muted, toggleMute, speaker, toggleSpeaker, remoteAudioRef } = useSip(myExt, {
    onConnected: () => {
      // Timer runs on connected time (not ringing) on both sides.
      callStartRef.current = Date.now()
      setCallStart(Date.now())
      setElapsed(0)
    },
    onRemoteHangup: (reason) => { finishCall(remoteNote(reason)) },
    onMissedCall: (from) => {
      peerRef.current = from || peerRef.current
      finishCall(from ? `Missed call from ${from}` : 'Missed call')
    },
    onNoAnswer: () => { finishCall('No answer') },
  })
  const { latest, alert } = useRiskSocket(sessionId)
  const level = latest?.risk_level ?? 'low'
  const risk = riskMeta(level)
  levelRef.current = level

  // call timer
  useEffect(() => {
    if (screen !== 'call' || !callStart) return
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - callStart) / 1000)), 500)
    return () => clearInterval(t)
  }, [screen, callStart])

  const loadRecents = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_HTTP}/api/calls`)
      const data = await res.json()
      setServerRecents(Array.isArray(data) ? data : [])
    } catch { /* offline — local recents still work */ }
  }, [])
  useEffect(() => { loadRecents() }, [loadRecents])

  // incoming call -> show call screen as ringing
  useEffect(() => {
    if (incoming) {
      peerRef.current = incoming.from
      setPeer(incoming.from)
      setScreen('call')
      setElapsed(0)
    }
  }, [incoming])

  const pushDigit = useCallback((k) => {
    if (screenRef.current !== 'dial') return
    setDigits((d) => (d + k).slice(0, 15))
  }, [])

  // physical keyboard support on PC: digits, backspace, Enter = call, Esc = hangup/close
  useEffect(() => {
    const onKey = (e) => {
      if (showIdentity) {
        if (e.key === 'Escape') setShowIdentity(false)
        return
      }
      if (screenRef.current === 'call') {
        if (e.key === 'Escape') document.getElementById('hangup-btn')?.click()
        return
      }
      if (/^[0-9*#]$/.test(e.key)) pushDigit(e.key)
      else if (e.key === 'Backspace') setDigits((d) => d.slice(0, -1))
      else if (e.key === 'Enter') document.getElementById('call-btn')?.click()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pushDigit, showIdentity])

  const startCall = async (target) => {
    const num = (target ?? digits).trim()
    if (!num || !myExt || screenRef.current === 'call') return
    peerRef.current = num
    setPeer(num)
    setScreen('call')
    setElapsed(0)
    setLastCall(null)
    callStartRef.current = Date.now()
    setCallStart(Date.now())
    try {
      const res = await fetch(`${BACKEND_HTTP}/api/calls/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'live' }),
      })
      const data = await res.json()
      setSessionId(data.session_id)
    } catch { setSessionId(null) }
    try { await call(num) } catch {}
  }

  const endCall = async () => {
    const p = peerRef.current
    hangup(p, 'ended')
    await finishCall(null)
  }

  const acceptCall = async () => {
    callStartRef.current = Date.now()
    setCallStart(Date.now())
    setElapsed(0)
    try {
      const res = await fetch(`${BACKEND_HTTP}/api/calls/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'live' }),
      })
      const data = await res.json()
      setSessionId(data.session_id)
    } catch {}
    try { await acceptIncoming() } catch {}
  }

  const declineCall = () => {
    const p = peerRef.current
    rejectIncoming()
    setScreen('dial')
    setPeer('')
    peerRef.current = ''
    setLastCall({ peer: p, duration: 0, level: 'low', note: 'You declined' })
  }

  const redial = () => {
    const last = localRecents[0]?.peer
    if (last) startCall(last)
  }

  const myName = IDENTITIES.find((i) => i.ext === myExt)?.name ?? ''
  const ringing = !!incoming && !inCall && screen === 'call'
  const callingOut = screen === 'call' && !inCall && !incoming && status === 'calling'
  const statusText = ringing ? 'Incoming call' : callingOut ? 'Calling…' : fmtTime(elapsed)
  const canCall = !!digits && registered && screen === 'dial'

  // Ringtones follow call state: ringback while dialling out, ringer on
  // incoming. Stopped on answer / hangup / remote end via cleanup.
  useEffect(() => {
    if (callingOut) startRingback()
    else stopRingback()
    return () => stopRingback()
  }, [callingOut])
  useEffect(() => {
    if (ringing) startRinger()
    else stopRinger()
    return () => stopRinger()
  }, [ringing])
  useEffect(() => () => stopAll(), [])

  const score = Math.round(latest?.fused_risk_score ?? 0)
  const hasScore = !!latest

  // Stream mic to the backend for live scoring while a call session is up.
  useEffect(() => {
    if (screen === 'call' && sessionId) {
      startMicUpload(sessionId)
      return () => stopMicUpload()
    }
    stopMicUpload()
  }, [screen, sessionId, startMicUpload, stopMicUpload])

  // Urgent beep while the threat is high during a call: once on entering
  // high, then repeated every 12s until it drops or the call ends.
  useEffect(() => {
    if (screen !== 'call' || level !== 'high') return
    playThreatBeep()
    const t = setInterval(playThreatBeep, 12000)
    return () => clearInterval(t)
  }, [screen, level])

  const dialPane = (
    <section className={`pane dial-pane ${tab === 'keypad' ? 'show' : ''}`}>
      {lastCall && (
        <div className="ended-card">
          <i className="bi bi-telephone-x-fill" />
          <span>{lastCall.note ? `${lastCall.note}` : 'Call ended'}{lastCall.peer ? ` · ${lastCall.peer}` : ''} · {fmtTime(lastCall.duration)}</span>
          <button onClick={() => setLastCall(null)} aria-label="Dismiss"><i className="bi bi-x-lg" /></button>
        </div>
      )}

      <div className="number-box">
        <div className="number">
          {digits || <span className="placeholder">Enter number</span>}
        </div>
        {digits ? (
          <button className="backspace" onClick={() => setDigits((d) => d.slice(0, -1))} aria-label="Delete">
            <i className="bi bi-backspace-fill" />
          </button>
        ) : (
          localRecents[0] && (
            <button className="backspace dim" onClick={redial} aria-label="Redial" title={`Redial ${localRecents[0].peer}`}>
              <i className="bi bi-arrow-clockwise" />
            </button>
          )
        )}
      </div>

      <div className="quick-row">
        {IDENTITIES.filter((i) => i.ext !== myExt).slice(0, 3).map((i) => (
          <button key={i.ext} className="chip" onClick={() => setDigits(i.ext)}>
            <i className="bi bi-person-circle" /> {i.name} · {i.ext}
          </button>
        ))}
      </div>

      <div className="pad">
        {KEYS.map((k) => (
          <button key={k.d} className="key" onClick={() => pushDigit(k.d)} aria-label={`Dial ${k.d}`}>
            <span className="digit">{k.d}</span>
            {k.s && <span className="sub">{k.s}</span>}
          </button>
        ))}
      </div>

      <div className="call-row">
        <button id="call-btn" className="call-btn" disabled={!canCall} onClick={() => startCall()} title={registered ? 'Call' : 'Connecting…'}>
          <i className="bi bi-telephone-fill" />
        </button>
        {!registered && <div className="hint"><i className="bi bi-arrow-left-right" /> Connecting… pick your number above</div>}
      </div>
    </section>
  )

  const recentsPane = (
    <aside className={`pane recents-pane ${tab === 'recents' ? 'show' : ''}`}>
      <div className="recents-head">
        <h2><i className="bi bi-clock-history" /> Recents</h2>
        <button className="ghost" onClick={loadRecents} title="Refresh"><i className="bi bi-arrow-clockwise" /> Refresh</button>
      </div>
      {localRecents.length === 0 && serverRecents.length === 0 && (
        <div className="empty"><i className="bi bi-telephone-x-fill" /><p>No calls yet</p></div>
      )}
      {localRecents.map((r, idx) => (
        <div key={`local-${r.startedAt}-${idx}`} className="recent-row">
          <div className="avatar"><i className="bi bi-person-circle" /></div>
          <div className="recent-meta">
            <div className="recent-top">
              <strong>{r.peer}</strong>
              <span className={`mini-dot ${r.level === 'high' ? 'bad' : r.level === 'medium' ? 'warn' : 'ok'}`} title={r.level} />
            </div>
            <div className="recent-sub">
              {r.note ? `${r.note} · ` : ''}{fmtTime(r.duration)} · {r.startedAt ? new Date(r.startedAt).toLocaleString() : ''}
            </div>
          </div>
          <button className="icon-btn" onClick={() => startCall(r.peer)} title={`Call ${r.peer}`} disabled={screen === 'call'}>
            <i className="bi bi-telephone-fill" />
          </button>
        </div>
      ))}
      {serverRecents.length > 0 && (
        <>
          <div className="server-label">Server history</div>
          {serverRecents.slice(0, 10).map((c) => (
            <div key={c.session_id} className="recent-row static">
              <div className="avatar sm"><i className="bi bi-telephone-inbound-fill" /></div>
              <div className="recent-meta">
                <div className="recent-top">
                  <strong className="mono">{c.session_id.slice(0, 8)}</strong>
                  <span className={`mini-dot ${c.final_risk_level === 'high' ? 'bad' : c.final_risk_level === 'medium' ? 'warn' : 'ok'}`} />
                </div>
                <div className="recent-sub">
                  {c.mode} · {c.final_risk_score != null ? `${Number(c.final_risk_score).toFixed(0)}` : '—'}
                  {' · '}{c.started_at ? new Date(c.started_at).toLocaleString() : ''}
                </div>
              </div>
            </div>
          ))}
        </>
      )}
      {localRecents.length > 0 && (
        <button className="ghost full" onClick={() => persistLocal([])}>Clear recents</button>
      )}
    </aside>
  )

  return (
    <div className="app-shell">
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />

      <div className="phone">
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark"><i className="bi bi-telephone-fill" /></div>
            <span>Auralis</span>
          </div>
          <button className="identity-btn" onClick={() => screen === 'dial' && setShowIdentity(true)} title="Choose your number">
            <span className={`presence ${registered ? 'on' : ''}`} />
            <i className="bi bi-person-circle" />
            {myExt} · {myName}
            <i className="bi bi-chevron-down chev" />
          </button>
        </header>

        {screen === 'dial' ? (
          <main className="screen dual">
            {dialPane}
            {recentsPane}
            <nav className="tabbar">
              <button className={tab === 'keypad' ? 'active' : ''} onClick={() => setTab('keypad')}>
                <i className="bi bi-grid-3x3-gap-fill tab-icon" />Keypad
              </button>
              <button className={tab === 'recents' ? 'active' : ''} onClick={() => setTab('recents')}>
                <i className="bi bi-clock-history tab-icon" />Recents
                {localRecents.length > 0 && <span className="count">{localRecents.length}</span>}
              </button>
            </nav>
          </main>
        ) : (
          <main className="screen call-screen">
            {alert && level === 'high' && (
              <div className="danger-banner"><i className="bi bi-exclamation-triangle-fill" /> Possible cloned voice detected</div>
            )}
            <div className="secure-pill" style={{ borderColor: hasScore ? risk.dot : '#ffb020' }}>
              <i className={`bi ${risk.icon}`} style={{ color: hasScore ? risk.dot : '#ffb020' }} />
              {hasScore ? risk.label : 'Listening…'}
            </div>

            <div className="caller">
              <div className="big-avatar"><i className="bi bi-person-circle" /></div>
              <h1>{peer || 'Unknown'}</h1>
              <p className="call-status">{statusText}</p>
              <p className="risk-sub">{hasScore ? risk.sub : uploadedChunks > 0 ? `Analyzed ${uploadedChunks} chunk${uploadedChunks === 1 ? '' : 's'} — keep talking` : 'Listening… speak to score'}</p>
            </div>

            <div className="threat-card">
              <div className="threat-top">
                <span className="threat-label"><i className={`bi ${risk.icon}`} style={{ color: hasScore ? risk.dot : '#5b6577' }} /> Threat score</span>
                <strong style={{ color: hasScore ? risk.dot : '#5b6577' }}>{hasScore ? score : '—'}</strong>
              </div>
              <div className="threat-bar">
                <div className="threat-fill" style={{ width: `${hasScore ? score : 0}%`, background: hasScore ? risk.dot : 'transparent' }} />
              </div>
            </div>

            <div className="vol-row" title="Caller voice volume">
              <i className={`bi ${remoteLevel > 0.05 ? 'bi-volume-up-fill' : 'bi-volume-mute-fill'}`} />
              <div className="vol-line">
                <div className="vol-fill" style={{ width: `${Math.round(remoteLevel * 100)}%` }} />
              </div>
            </div>

            <div className="in-call-grid">
              <button className={`round ${muted ? 'on' : ''}`} onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
                <span><i className={`bi ${muted ? 'bi-mic-mute-fill' : 'bi-mic-fill'}`} /></span><small>{muted ? 'Unmute' : 'Mute'}</small>
              </button>
              <button className={`round ${speaker ? 'on' : ''}`} onClick={toggleSpeaker} title="Speaker">
                <span><i className="bi bi-volume-up-fill" /></span><small>Speaker</small>
              </button>
              <button className="round" onClick={() => setDigits('')} title="Keypad">
                <span><i className="bi bi-grid-3x3-gap-fill" /></span><small>Keypad</small>
              </button>
            </div>

            {ringing ? (
              <div className="answer-row">
                <button className="decline" onClick={declineCall} title="Decline"><i className="bi bi-telephone-x-fill" /><small>Decline</small></button>
                <button className="accept" onClick={acceptCall} title="Accept"><i className="bi bi-telephone-fill" /><small>Accept</small></button>
              </div>
            ) : (
              <button id="hangup-btn" className="hangup" onClick={endCall} aria-label="Hang up" title="Hang up">
                <i className="bi bi-telephone-fill" />
              </button>
            )}
          </main>
        )}

        {showIdentity && (
          <div className="sheet-backdrop" onClick={() => setShowIdentity(false)}>
            <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Choose your number">
              <h3><i className="bi bi-person-circle" /> My number</h3>
              <p>Choose which extension you are calling from.</p>
              {IDENTITIES.map((i) => (
                <button
                  key={i.ext}
                  className={`id-row ${myExt === i.ext ? 'sel' : ''}`}
                  onClick={() => { setMyExt(i.ext); setShowIdentity(false) }}
                >
                  <span className="avatar"><i className="bi bi-person-circle" /></span>
                  <span className="id-meta"><strong>{i.name}</strong><small>{i.ext}</small></span>
                  {myExt === i.ext && <span className="tick"><i className="bi bi-check-lg" /></span>}
                </button>
              ))}
              <button className="ghost full" onClick={() => setShowIdentity(false)}><i className="bi bi-x-lg" /> Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
