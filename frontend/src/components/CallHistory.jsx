import React, { useEffect, useState } from 'react'
import { BACKEND_HTTP } from '../lib/config.js'

export default function CallHistory({ refreshKey }) {
  const [calls, setCalls] = useState([])
  const [detail, setDetail] = useState(null)

  const load = async () => {
    const res = await fetch(`${BACKEND_HTTP}/api/calls`)
    const data = await res.json()
    setCalls(data)
  }
  useEffect(() => { load() }, [refreshKey])

  const open = async (id) => {
    const res = await fetch(`${BACKEND_HTTP}/api/calls/${id}`)
    const data = await res.json()
    setDetail(data)
  }

  return (
    <div className="card card-pad">
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:10 }}>
        <h3 style={{ fontWeight:900, letterSpacing:'-0.02em' }}>History</h3>
        <button onClick={load} className="btn-ghost" style={{ padding:'8px 12px', fontSize:12 }}>↻ Refresh</button>
      </div>

      <div className="table-wrap" style={{ marginTop:12 }}>
        <table>
          <thead><tr><th>Session</th><th>Mode</th><th className="hide-mobile">Started</th><th>Score</th><th>Status</th></tr></thead>
          <tbody>
            {calls.map(c => (
              <tr key={c.session_id} onClick={() => open(c.session_id)} style={{ cursor:'pointer' }}>
                <td><span className="mono" style={{ background:'rgba(255,255,255,0.06)', padding:'4px 8px', borderRadius:8, fontSize:12 }}>{c.session_id.slice(0, 8)}</span></td>
                <td><span className="badge badge-idle" style={{ padding:'4px 8px', fontSize:11 }}>{c.mode}</span></td>
                <td className="hide-mobile" style={{ color:'var(--muted)', fontSize:12 }}>{new Date(c.started_at).toLocaleTimeString()}</td>
                <td style={{ fontWeight:700 }}>{c.final_risk_score ?? '—'}</td>
                <td><span className={`level level-${c.final_risk_level || 'low'}`}>{c.final_risk_level || 'pending'}</span></td>
              </tr>
            ))}
            {calls.length === 0 && <tr><td colSpan={5} style={{ opacity:.5, padding:20, textAlign:'center' }}>No calls yet — start a replay above</td></tr>}
          </tbody>
        </table>
      </div>

      {detail && (
        <div style={{ marginTop:16, background:'rgba(0,0,0,0.18)', border:'1px solid rgba(255,255,255,0.06)', padding:14, borderRadius:14 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <strong className="mono" style={{ fontSize:13 }}>▮ {detail.session_id.slice(0, 8)} — {detail.scores.length} chunks</strong>
            <button onClick={() => setDetail(null)} className="btn-ghost" style={{ padding:'6px 10px' }}>✕</button>
          </div>
          <div style={{ display:'flex', alignItems:'flex-end', gap:3, height:80, marginTop:12, background:'rgba(255,255,255,0.03)', padding:8, borderRadius:12 }}>
            {detail.scores.map(s => (
              <div key={s.chunk_index} title={`${s.fused_risk_score}`} style={{
                flex:1, background: s.risk_level === 'high' ? '#ef4444' : s.risk_level === 'medium' ? '#f59e0b' : '#22c55e',
                height: `${Math.max(4, s.fused_risk_score)}%`, borderRadius:3
              }} />
            ))}
            {detail.scores.length === 0 && <span style={{ opacity:.5, fontSize:12 }}>No chunks yet</span>}
          </div>
          <div style={{ marginTop:10, fontSize:11, color:'var(--muted)', display:'grid', gap:4, maxHeight:120, overflowY:'auto' }}>
            {detail.scores.map(s => (
              <div key={s.chunk_index} className="mono">#{s.chunk_index} · {s.fused_risk_score} ({s.risk_level}) · AASIST {s.model_scores.aasist} · RawNet2 {s.model_scores.rawnet2} · XLSR {s.model_scores.xlsr}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
