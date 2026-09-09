import React from 'react'

const KEYS = [
  ['1','2','3'],
  ['4','5','6'],
  ['7','8','9'],
  ['*','0','#'],
]

export default function DialPad({ value, setValue, onCall, onHangup, inCall, disabled }) {
  const push = (k) => setValue(v => v + k)
  return (
    <div className="card card-pad">
      <div className="section-title">Phone</div>
      <div className="dial-display mono">
        {value ? <span>{value}</span> : <span style={{ opacity:.35, fontSize:14, letterSpacing:'.06em' }}>enter number — try 1001…1005</span>}
      </div>

      <div className="dial-grid">
        {KEYS.flat().map(k=>(
          <button key={k} onClick={() => push(k)} disabled={disabled} className="dial-key">{k}</button>
        ))}
      </div>

      <div style={{ display:'flex', gap:10, marginTop:14 }}>
        <button onClick={() => setValue(v => v.slice(0,-1))} className="btn-ghost" style={{ flex:1 }}>⌫ Delete</button>
        {!inCall ? (
          <button onClick={onCall} disabled={!value || disabled} className="btn-primary" style={{ flex:2 }}>
            {disabled ? 'Select identity first' : '● Call'}
          </button>
        ) : (
          <button onClick={onHangup} className="btn-danger" style={{ flex:2 }}>■ Hang up</button>
        )}
      </div>

      <div style={{ marginTop:10, display:'flex', gap:6, flexWrap:'wrap' }}>
        <span className="badge badge-idle" style={{ fontSize:11 }}>Web→Web: 1001-1005</span>
        <span className="badge badge-idle" style={{ fontSize:11 }}>Echo: 9196</span>
      </div>
    </div>
  )
}
