import React from 'react'

const NUMBERS = [
  { ext: '1001', label: 'Alice', pass: '1001pass', role:'Product' },
  { ext: '1002', label: 'Bob', pass: '1002pass', role:'Security' },
  { ext: '1003', label: 'Carol', pass: '1003pass', role:'Support' },
  { ext: '1004', label: 'Dave', pass: '1004pass', role:'Ops' },
  { ext: '1005', label: 'Eve', pass: '1005pass', role:'QA' },
]

export default function NumberSelector({ myNumber, setMyNumber }) {
  return (
    <div className="card card-pad">
      <div className="section-title">Identity</div>
      <h3 style={{ fontWeight:900, fontSize:16 }}>Who is calling?</h3>
      <p style={{ fontSize:12, color:'var(--muted)', marginTop:4 }}>Registers via WebRTC (STUN) + SIP.js. Asterisk optional — fallback signaling works without it.</p>

      <div style={{ display:'grid', gap:8, marginTop:14 }}>
        {NUMBERS.map(n=>{
          const active = myNumber===n.ext
          return (
            <button
              key={n.ext}
              onClick={()=>setMyNumber(n.ext)}
              style={{
                display:'flex',alignItems:'center',gap:12,padding:'12px 14px',borderRadius:14,
                border: active ? '1px solid #22c55e' : '1px solid rgba(255,255,255,0.08)',
                background: active ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.04)',
                color:'var(--text)',textAlign:'left',transition:'.15s'
              }}
            >
              <div style={{
                width:36,height:36,borderRadius:999,display:'grid',placeItems:'center',
                background: active ? '#22c55e' : 'rgba(255,255,255,0.08)', color: active ? '#06210f' : 'white',
                fontWeight:900,fontSize:13
              }}>{n.ext.slice(-2)}</div>
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:800, fontSize:14 }}>{n.label} <span style={{ fontWeight:600, color:'var(--muted)' }}>· {n.ext}</span></div>
                <div style={{ fontSize:11, color:'var(--muted)' }}>{n.role} — 100{n.ext.slice(-1)}pass</div>
              </div>
              <div style={{ width:18, height:18, borderRadius:999, border:'2px solid '+(active?'#22c55e':'rgba(255,255,255,0.2)'), display:'grid', placeItems:'center' }}>
                {active && <div style={{ width:8, height:8, borderRadius:999, background:'#22c55e' }} />}
              </div>
            </button>
          )
        })}
      </div>

      <div style={{ marginTop:12, fontSize:11, color:'var(--muted-2)', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.06)', padding:'10px 12px', borderRadius:12 }}>
        <div className="mono" style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
          <span>sip:{myNumber || '___'}@x.lan</span><span style={{opacity:.4}}>•</span><span>wss://x.lan/asterisk/ws</span>
        </div>
      </div>
    </div>
  )
}
export { NUMBERS }
