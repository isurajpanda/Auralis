import React from 'react'

export default function RiskGauge({ score, level }) {
  const pct = Math.max(0, Math.min(100, score ?? 0))
  let color = '#22c55e'
  let label = 'Low risk'
  if (level === 'medium') { color = '#f59e0b'; label = 'Suspicious' }
  if (level === 'high') { color = '#ef4444'; label = 'High risk' }

  const r = 78
  const c = 2 * Math.PI * r
  const offset = c * (1 - pct / 100)

  return (
    <div className="card card-pad" style={{ textAlign:'center' }}>
      <div className="kicker" style={{ justifyContent:'center', display:'flex' }}>Impersonation risk</div>
      <div className="gauge-ring" style={{ marginTop:12 }}>
        <svg width="100%" height="100%" viewBox="0 0 180 180">
          <circle cx="90" cy="90" r={r} className="gauge-bg" />
          <circle
            cx="90" cy="90" r={r}
            className="gauge-fg"
            style={{ stroke: color, strokeDasharray: c, strokeDashoffset: offset }}
          />
        </svg>
        <div style={{ position:'absolute', inset:0, display:'grid', placeItems:'center' }}>
          <div>
            <div style={{ fontSize:42, fontWeight:900, letterSpacing:'-0.04em', color }}>{pct.toFixed(1)}</div>
            <div style={{ fontSize:11, fontWeight:800, letterSpacing:'.18em', textTransform:'uppercase', color, marginTop:2 }}>{label}</div>
            <div style={{ fontSize:11, color:'var(--muted)', marginTop:4 }} className="mono">{level ?? '—'} • {pct < 30 ? 'safe' : pct < 70 ? 'review' : 'block'}</div>
          </div>
        </div>
      </div>

      <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'var(--muted)', marginTop:12, padding:'0 6px' }}>
        <span>0</span><span style={{ color: pct >= 30 ? 'var(--muted)' : '#22c55e' }}>30</span><span style={{ color: pct >= 70 ? '#ef4444' : 'var(--muted)' }}>70</span><span>100</span>
      </div>
      <div style={{ height:8, background:'#0a1430', borderRadius:999, overflow:'hidden', marginTop:6, border:'1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ width:`${pct}%`, height:'100%', background:color, transition:'width .5s ease' }} />
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginTop:14, textAlign:'left' }}>
        {[
          { k:'AASIST', v:'spectral', pct: Math.min(100, pct*0.95) },
          { k:'RawNet2', v:'waveform', pct: Math.min(100, pct*1.02) },
          { k:'XLS-R', v:'semantic', pct: Math.min(100, pct*0.98) },
        ].map(m=>(
          <div key={m.k} style={{ background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.06)', borderRadius:12, padding:'10px 8px' }}>
            <div style={{ fontSize:10, letterSpacing:'.1em', textTransform:'uppercase', color:'var(--muted)', fontWeight:700 }}>{m.k}</div>
            <div style={{ fontSize:11, color:'var(--muted)' }}>{m.v}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
