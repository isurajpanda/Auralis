import React, { useState, useEffect, useRef } from 'react'
import CallPanel from '../components/CallPanel.jsx'
import RiskGauge from '../components/RiskGauge.jsx'
import AlertBanner from '../components/AlertBanner.jsx'
import CallHistory from '../components/CallHistory.jsx'
import ActivityLog from '../components/ActivityLog.jsx'
import { useRiskSocket } from '../hooks/useRiskSocket.js'
import { BACKEND_HTTP } from '../lib/config.js'
import { CONTACTS, nameFor } from '../lib/contacts.js'
import { logActivity } from '../lib/activityLog.js'
import { Link } from 'react-router-dom'

function usePresence(pollMs = 5000) {
  const [presence, setPresence] = useState([])
  const [online, setOnline] = useState(true)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch(`${BACKEND_HTTP}/api/presence`)
        if (!res.ok) throw new Error(`http ${res.status}`)
        const data = await res.json()
        if (alive) { setPresence(Array.isArray(data) ? data : []); setOnline(true) }
      } catch {
        if (alive) setOnline(false)
      }
    }
    load()
    const t = setInterval(load, pollMs)
    return () => { alive = false; clearInterval(t) }
  }, [pollMs])
  return { presence, online }
}

function useBackendHealth(pollMs = 15000) {
  const [health, setHealth] = useState({ status: '…', models_loaded: [] })
  const [reachable, setReachable] = useState(true)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch(`${BACKEND_HTTP}/health`)
        if (!res.ok) throw new Error(`http ${res.status}`)
        const data = await res.json()
        if (alive) { setHealth(data); setReachable(true) }
      } catch {
        if (alive) setReachable(false)
      }
    }
    load()
    const t = setInterval(load, pollMs)
    return () => { alive = false; clearInterval(t) }
  }, [pollMs])
  return { health, reachable }
}

export default function Dashboard({ sessionId, setSessionId }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const { history, latest, alert, connected } = useRiskSocket(sessionId)
  const { presence, online } = usePresence()
  const { health, reachable } = useBackendHealth()
  const byExt = Object.fromEntries(presence.map((p) => [p.extension, p]))
  const onlineCount = presence.length
  const handleEnd = async () => {
    setRefreshKey(k => k + 1)
    setSessionId(null)
  }
  const score = latest?.fused_risk_score ?? 0
  const level = latest?.risk_level ?? 'low'

  // ---- activity logging (transitions only, never per-chunk spam) ----
  const prevRef = useRef({ sid: null, connected: false, level: 'low', online: true, reachable: true, exts: '' })
  useEffect(() => {
    const p = prevRef.current
    if (sessionId && !p.sid) logActivity('ok', `Session started (${String(sessionId).slice(0, 8)})`)
    if (!sessionId && p.sid) logActivity('info', `Session ended (${String(p.sid).slice(0, 8)})`)
    p.sid = sessionId || null
  }, [sessionId])
  useEffect(() => {
    const p = prevRef.current
    if (connected && !p.connected) logActivity('ok', 'Risk stream connected')
    if (!connected && p.connected) logActivity('warn', 'Risk stream disconnected')
    p.connected = connected
  }, [connected])
  useEffect(() => {
    const p = prevRef.current
    if (level !== p.level) {
      logActivity(level === 'high' ? 'alert' : level === 'medium' ? 'warn' : 'ok',
        `Risk level → ${level}${latest ? ` (${latest.fused_risk_score})` : ''}`)
      p.level = level
    }
  }, [level, latest])
  useEffect(() => {
    if (alert?.message) logActivity('alert', `Alert: ${alert.message}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alert])
  useEffect(() => {
    const p = prevRef.current
    if (online && !p.online) logActivity('ok', 'Backend reachable again')
    if (!online && p.online) logActivity('error', 'Backend unreachable (presence feed down)')
    p.online = online
    const sig = presence.map((x) => `${x.extension}:${x.connections}:${x.in_call ? `call-${x.in_call_with ?? '?'}` : 'idle'}`).sort().join('|')
    if (p.exts && sig !== p.exts) {
      const before = Object.fromEntries(p.exts.split('|').filter(Boolean).map((s) => { const [e, c, st] = s.split(':'); return [e, st] }))
      presence.forEach((x) => {
        const cur = x.in_call ? `call-${x.in_call_with ?? '?'}` : 'idle'
        const was = before[x.extension]
        if (was === undefined) logActivity('info', `${nameFor(x.extension) || x.extension} (${x.extension}) came online`)
        else if (was !== cur) {
          logActivity(x.in_call ? 'warn' : 'info',
            x.in_call
              ? `${nameFor(x.extension) || x.extension} (${x.extension}) in call → ${x.in_call_with ?? '?'}`
              : `${nameFor(x.extension) || x.extension} (${x.extension}) back to idle`)
        }
      })
      Object.keys(before).forEach((e) => {
        if (!presence.some((x) => x.extension === e)) logActivity('info', `${nameFor(e) || e} (${e}) went offline`)
      })
    }
    p.exts = sig
  }, [presence, online])
  useEffect(() => {
    const p = prevRef.current
    if (reachable && !p.reachable) logActivity('ok', 'Health feed recovered')
    if (!reachable && p.reachable) logActivity('error', 'Health feed unreachable')
    p.reachable = reachable
  }, [reachable])
  return (
    <div className="dash-wrap">
      <div style={{ marginBottom: 12 }}>
        <Link to="/" className="back-link">← Back to phone</Link>
      </div>
      <AlertBanner alert={alert} />
      <div className="dash-card" style={{ marginBottom: 16 }}>
        <div className="dash-sec-title">
          <h3>Connected clients <span style={{ opacity: 0.55, fontWeight: 400, fontSize: 13 }}>({onlineCount}/{CONTACTS.length} online)</span></h3>
          <span style={{ fontSize: 11, opacity: 0.6 }}>{online ? '● live' : '○ backend unreachable'}</span>
        </div>
        <div className="presence-grid">
          {CONTACTS.map((c) => {
            const p = byExt[c.ext]
            const st = !p ? 'offline' : p.in_call ? 'in-call' : 'online'
            const dot = st === 'in-call' ? '#eab308' : st === 'online' ? '#22c55e' : '#475569'
            const label = st === 'in-call' ? `In call${p.in_call_with ? ` → ${p.in_call_with} (${nameFor(p.in_call_with)})` : ''}` : st === 'online' ? `Online${p.connections > 1 ? ` ×${p.connections}` : ''}` : 'Offline'
            return (
              <div key={c.ext} style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#050505', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: '10px 12px' }} title={`${c.name} · ${c.ext} — ${label}`}>
                <span style={{ width: 10, height: 10, borderRadius: 999, background: dot, boxShadow: `0 0 8px ${dot}` }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{c.name} <span style={{ opacity: 0.5, fontWeight: 400 }}>· {c.ext}</span></div>
                  <div style={{ fontSize: 11, opacity: 0.65, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <div className="dash-grid-2">
        <div className="dash-card">
          <h3 style={{ marginBottom: 8 }}>Active session</h3>
          {sessionId ? (
            <div style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div><span style={{ opacity: 0.6 }}>ID </span><code>{sessionId.slice(0, 8)}</code> <span style={{ opacity: 0.4 }} className="mono">{sessionId}</span></div>
              <div><span style={{ opacity: 0.6 }}>Stream </span>{connected ? '● connected' : '○ connecting…'} · {history.length} chunk{history.length === 1 ? '' : 's'} scored</div>
              <div><span style={{ opacity: 0.6 }}>Latest </span>{latest ? `${latest.fused_risk_score} (${latest.risk_level}) · chunk #${latest.chunk_index}` : '— waiting for first chunk'}</div>
              {latest?.model_scores && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                  {Object.entries(latest.model_scores).map(([k, v]) => (
                    <span key={k} style={{ fontSize: 11, background: '#050505', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 999, padding: '4px 10px' }} title={`P(fake) from ${k}`}>{k} {v}</span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 13, opacity: 0.6 }}>No active session — start a replay below or a live call on the phone page (it streams here automatically).</div>
          )}
        </div>
        <div className="dash-card">
          <div className="dash-sec-title">
            <h3>Backend</h3>
            <span style={{ fontSize: 11, opacity: 0.6 }}>{reachable ? `● ${health.status}` : '○ unreachable'}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(health.models_loaded ?? []).map((m) => (
              <span key={m} style={{ fontSize: 11, background: '#050505', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 999, padding: '4px 10px' }}>● {m}</span>
            ))}
            {(health.models_loaded ?? []).length === 0 && <span style={{ fontSize: 12, opacity: 0.6 }}>No models reported</span>}
          </div>
          <div style={{ marginTop: 12, fontSize: 12, opacity: 0.75 }}>
            <div><span style={{ color: '#22c55e' }}>●</span> Low &lt; 15 · <span style={{ color: '#eab308' }}>●</span> Medium 15–70 · <span style={{ color: '#ef4444' }}>●</span> High ≥ 70 <span style={{ opacity: 0.6 }}>(backend .env)</span></div>
            <div style={{ marginTop: 4, opacity: 0.8 }}>Sustained medium+ over 2 chunks also raises an alert.</div>
          </div>
        </div>
      </div>
      <div className="dash-grid-main">
        <div>
          <CallPanel sessionId={sessionId} connected={connected} onStart={setSessionId} onEnd={handleEnd} />
          <div className="dash-card" style={{ marginTop: 16 }}>
            <h3 style={{ marginBottom: 8 }}>Live Score Stream</h3>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120, background: '#050505', border: '1px solid rgba(255,255,255,0.06)', padding: 10, borderRadius: 8 }}>
              {history.length === 0 && <span style={{ opacity: 0.5, fontSize: 12 }}>Start a replay or live call to see risk updates (2s/chunk)</span>}
              {history.map(h => (
                <div key={h.chunk_index} style={{
                  flex: 1, maxWidth: 32,
                  height: `${Math.max(6, h.fused_risk_score)}%`,
                  background: h.risk_level === 'high' ? '#ef4444' : h.risk_level === 'medium' ? '#eab308' : '#22c55e',
                  borderRadius: 3, transition: 'height 0.4s'
                }} title={`#${h.chunk_index} ${h.fused_risk_score}`} />
              ))}
            </div>
            {latest?.model_scores && (
              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
                Chunk #{latest.chunk_index} — {Object.entries(latest.model_scores).map(([k, v]) => `${k} ${v}`).join(' • ')}
              </div>
            )}
          </div>
          <CallHistory refreshKey={refreshKey} />
        </div>
        <div>
          <RiskGauge score={score} level={level} />
          <div className="dash-card" style={{ marginTop: 16, fontSize: 13 }}>
            <h4 style={{ marginBottom: 8 }}>How it works</h4>
            <ol style={{ paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 6, opacity: 0.85 }}>
              <li>Audio streamed in 2s chunks (replay or live mic)</li>
              <li>5 detectors score in parallel (heuristics + pretrained)</li>
              <li>Fused 0–100 risk (smoothed over 3 chunks)</li>
              <li>WebSocket pushes live</li>
              <li>Alert if ≥70, or medium+ twice in a row</li>
            </ol>
          </div>
          <div style={{ marginTop: 16 }}>
            <ActivityLog />
          </div>
        </div>
      </div>
    </div>
  )
}
