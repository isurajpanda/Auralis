import React, { useState } from 'react'
import { BACKEND_HTTP } from '../lib/config.js'
import { logActivity } from '../lib/activityLog.js'

export default function CallPanel({ onStart, onEnd, sessionId, connected }) {
  const [loading, setLoading] = useState(false)
  const handle = async (sample) => {
    setLoading(true)
    try {
      const res = await fetch(`${BACKEND_HTTP}/api/calls/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'replay', replay_sample: sample })
      })
      if (!res.ok) throw new Error(`http ${res.status}`)
      const data = await res.json()
      logActivity('ok', `Replay started: ${sample} (${String(data.session_id).slice(0, 8)})`)
      onStart(data.session_id)
    } catch (e) {
      logActivity('error', `Replay start failed: ${e.message}`)
      alert('Failed to start call: ' + e.message)
    } finally { setLoading(false) }
  }
  const handleEnd = async () => {
    if (!sessionId) return
    try {
      const res = await fetch(`${BACKEND_HTTP}/api/calls/${sessionId}/end`, { method: 'POST' })
      if (!res.ok) throw new Error(`http ${res.status}`)
      const data = await res.json().catch(() => ({}))
      logActivity('info', `Replay ended (${String(sessionId).slice(0, 8)})${data.final_risk_score != null ? ` — final ${data.final_risk_score} (${data.final_risk_level ?? data.risk_level ?? '?'})` : ''}`)
    } catch (e) {
      logActivity('warn', `Replay end call failed: ${e.message} — clearing locally`)
    }
    onEnd()
  }
  return (
    <div className="card card-pad">
      <div className="section-title">● Demo replay — no hardware needed</div>
      <h3 style={{ fontSize:18, fontWeight:900, letterSpacing:'-0.02em' }}>Try the detector</h3>
      <p style={{ fontSize:13, color:'var(--muted)', marginTop:6, lineHeight:1.5 }}>
        Streams a sample WAV chunk-by-chunk through the same pipeline as a live call. Compare <b style={{color:'var(--text)'}}>bonafide</b> vs <b style={{color:'var(--text)'}}>cloned</b>.
      </p>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginTop:16 }}>
        <button
          onClick={() => handle('bonafide')}
          disabled={loading || !!sessionId}
          className="btn-ghost"
          style={{ display: 'block', textAlign: 'left', padding: '12px 14px' }}
        >
          <div style={{ fontSize:12, opacity:.7, letterSpacing:'.08em', textTransform:'uppercase' }}>Step 1</div>
          <div style={{ fontSize:14, marginTop:2 }}>Normal voice</div>
          <div style={{ fontSize:11, opacity:.6, marginTop:4 }}>genuine sample • gauge stays green</div>
        </button>
        <button
          onClick={() => handle('cloned')}
          disabled={loading || !!sessionId}
          className="btn-danger"
          style={{ display: 'block', textAlign: 'left', padding: '12px 14px' }}
        >
          <div style={{ fontSize:12, opacity:.85, letterSpacing:'.08em', textTransform:'uppercase' }}>Step 2 — see alert</div>
          <div style={{ fontSize:14, marginTop:2 }}>Cloned voice</div>
          <div style={{ fontSize:11, opacity:.8, marginTop:4 }}>synthetic sample • watch the gauge</div>
        </button>
      </div>

      {sessionId ? (
        <div style={{ marginTop:14, display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
          <span className={connected ? 'badge badge-live' : 'badge badge-idle'}>{connected ? '● streaming' : '○ connecting'}</span>
          <span className="mono" style={{ fontSize:12, color:'var(--muted)' }}>{sessionId.slice(0,8)}...</span>
          <button onClick={handleEnd} className="btn-ghost" style={{ marginLeft:'auto', padding:'8px 14px' }}>End replay</button>
        </div>
      ) : (
        <div style={{ marginTop:12, fontSize:11, color:'var(--muted-2)', display:'flex', gap:6, alignItems:'center' }}>
          <span style={{ width:6, height:6, borderRadius:999, background:'var(--muted-2)' }} /> No active session — tap a sample above
        </div>
      )}
    </div>
  )
}
