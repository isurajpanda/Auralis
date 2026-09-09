import React, { useEffect, useRef } from 'react'

export default function AlertBanner({ alert }) {
  const audioRef = useRef(null)
  useEffect(() => {
    if (alert && audioRef.current) audioRef.current.play().catch(()=>{})
  }, [alert])
  if (!alert) return null
  return (
    <div className="alert" role="alert">
      <div style={{ width:42, height:42, borderRadius:12, background:'rgba(255,255,255,0.18)', display:'grid', placeItems:'center', fontSize:20 }}>⚠</div>
      <div style={{ flex:1 }}>
        <div style={{ fontWeight:900, letterSpacing:'.02em' }}>HIGH RISK — POSSIBLE CLONE</div>
        <div style={{ fontSize:13, opacity:.92, marginTop:2 }}>{alert.message || 'Voice does not match enrolled speaker. Consider step-up verification.'}</div>
      </div>
      <div style={{ fontSize:11, fontWeight:800, background:'white', color:'#dc2626', padding:'6px 10px', borderRadius:999 }}>BLOCK</div>
      <audio ref={audioRef} src="data:audio/wav;base64,UklGRlQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVgAAACAAP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP//AP//AP//AP//AP//AP//AP//AP//AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/wD/AP8A/w==" preload="auto" />
    </div>
  )
}
