import React, { useState } from 'react'
import CallPanel from '../components/CallPanel.jsx'
import RiskGauge from '../components/RiskGauge.jsx'
import AlertBanner from '../components/AlertBanner.jsx'
import CallHistory from '../components/CallHistory.jsx'
import { useRiskSocket } from '../hooks/useRiskSocket.js'

export default function Dashboard({ sessionId, setSessionId }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const { history, latest, alert, connected } = useRiskSocket(sessionId)
  const handleEnd = async () => {
    setRefreshKey(k => k + 1)
    setSessionId(null)
  }
  const score = latest?.fused_risk_score ?? 0
  const level = latest?.risk_level ?? 'low'
  return (
    <div>
      <AlertBanner alert={alert} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 16 }}>
        <div>
          <CallPanel sessionId={sessionId} connected={connected} onStart={setSessionId} onEnd={handleEnd} />
          <div style={{ background: '#1e293b', padding: 16, borderRadius: 12, marginTop: 16 }}>
            <h3 style={{ marginBottom: 8 }}>Live Score Stream</h3>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120, background: '#0f172a', padding: 10, borderRadius: 8 }}>
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
            {latest && (
              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
                Chunk #{latest.chunk_index} — AASIST {latest.model_scores.aasist} • RawNet2 {latest.model_scores.rawnet2} • XLSR {latest.model_scores.xlsr}
              </div>
            )}
          </div>
          <CallHistory refreshKey={refreshKey} />
        </div>
        <div>
          <RiskGauge score={score} level={level} />
          <div style={{ background: '#1e293b', padding: 16, borderRadius: 12, marginTop: 16, fontSize: 13 }}>
            <h4 style={{ marginBottom: 8 }}>How it works</h4>
            <ol style={{ paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 6, opacity: 0.85 }}>
              <li>Audio streamed in 2-4s chunks (replay or live mic)</li>
              <li>3 models score in parallel</li>
              <li>Fused 0–100 risk</li>
              <li>WebSocket pushes live</li>
              <li>Alert if &gt;70</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  )
}
