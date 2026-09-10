import React, { useEffect, useRef } from 'react'
import { useActivity, clearActivity, activityColor } from '../lib/activityLog.js'

function fmtTime(d) {
  try {
    return d.toLocaleTimeString([], { hour12: false })
  } catch {
    return ''
  }
}

export default function ActivityLog() {
  const entries = useActivity()
  const boxRef = useRef(null)

  // Follow the tail while new entries arrive (unless the user scrolled up).
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [entries.length])

  return (
    <div className="dash-card">
      <div className="dash-sec-title">
        <h3>Activity</h3>
        <button className="btn-ghost" style={{ padding: '6px 10px', fontSize: 11 }} onClick={clearActivity} title="Clear log">Clear</button>
      </div>
      <div ref={boxRef} className="activity-list">
        {entries.length === 0 && (
          <div style={{ opacity: 0.5, fontSize: 12 }}>Session starts, alerts, client joins and errors appear here.</div>
        )}
        {entries.map((e) => (
          <div key={e.id} className="activity-row">
            <span className="activity-time">{fmtTime(e.at)}</span>
            <span className="activity-dot" style={{ background: activityColor(e.level) }} />
            <span className="activity-msg">{e.msg}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
