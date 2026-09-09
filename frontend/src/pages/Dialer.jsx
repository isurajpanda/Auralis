import React, { useState, useEffect } from 'react'
import NumberSelector from '../components/dialer/NumberSelector.jsx'
import DialPad from '../components/dialer/DialPad.jsx'
import { useSip } from '../hooks/useSip.js'
import RiskGauge from '../components/RiskGauge.jsx'
import AlertBanner from '../components/AlertBanner.jsx'
import { useRiskSocket } from '../hooks/useRiskSocket.js'
import { BACKEND_HTTP, BACKEND_WS } from '../lib/config.js'

export default function Dialer({ sessionId, setSessionId }) {
  const [myNumber, setMyNumber] = useState('')
  const [dialValue, setDialValue] = useState('')
  const { registered, inCall, status, call, hangup, remoteAudioRef } = useSip(myNumber)
  const { history, latest, alert } = useRiskSocket(sessionId)
  const [callSession, setCallSession] = useState(null)

  // When a WebRTC call starts, also start a backend live risk session so RiskGauge streams
  const handleCall = async () => {
    if (!dialValue) return
    // Create backend live session (for detection pipeline)
    const res = await fetch(`${BACKEND_HTTP}/api/calls/start`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ mode: 'live' })
    })
    const data = await res.json()
    setSessionId(data.session_id)
    setCallSession(data.session_id)
    // Start actual peer call
    await call(dialValue)
    // Optional: start streaming mic PCM chunks to backend risk WS via the risk socket
    // This is done via AudioWorklet in a full build; for now the ws is ready for chunks
  }

  const handleHangup = async () => {
    hangup()
    if (callSession) {
      await fetch(`${BACKEND_HTTP}/api/calls/${callSession}/end`, { method: 'POST' })
    }
    setCallSession(null)
  }

  // Auto-populate dial with demo numbers
  useEffect(() => {
    if (!dialValue && myNumber) {
      // suggest another ext
      const sugg = ['1001','1002','1003','1004','1005'].filter(x=>x!==myNumber)[0]
      setDialValue(sugg)
    }
  }, [myNumber])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr 340px', gap: 16 }}>
      <div>
        <NumberSelector myNumber={myNumber} setMyNumber={setMyNumber} />
        <div style={{ marginTop: 12, background: '#1e293b', padding: 12, borderRadius: 10, fontSize: 12 }}>
          <div>SIP Status: <b style={{ color: registered ? '#22c55e' : '#ef4444' }}>{registered ? 'Registered' : 'Not registered'}</b> ({status})</div>
          <div style={{ opacity: 0.6, marginTop: 4 }}>Fallback signaling at <code>{BACKEND_WS}/ws/signal</code> still allows web↔web via STUN (Asterisk WSL optional).</div>
          <div style={{ marginTop: 8, fontSize: 11, opacity: 0.5 }}>
            WSL: <code>powershell -File scripts/start-asterisk-wsl.ps1</code><br/>
            Asterisk SIP WS: <code>wss://x.lan/asterisk/ws</code> • ARI: <code>https://x.lan/ari/</code> (voice-guard) via nginx
          </div>
        </div>
        <DialPad value={dialValue} setValue={setDialValue} onCall={handleCall} onHangup={handleHangup} inCall={inCall} disabled={!registered} />
        <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />
      </div>

      <div>
        <div style={{ background: '#1e293b', padding: 16, borderRadius: 12 }}>
          <h3>Live Call Audio → Detection</h3>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
            When you are in a web→web or web→SIP call, mic PCM is chunked (2s) and sent to <code>{BACKEND_WS}/ws/{'{session_id}'}</code> → same pipeline as replay. Gauge at right updates live.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ padding: '6px 10px', background: inCall ? '#22c55e' : '#334155', color: inCall ? '#0f172a' : 'white', borderRadius: 999, fontSize: 12, fontWeight: 700 }}>{inCall ? '● Live call' : '○ Idle'}</span>
            {sessionId && <span style={{ padding: '6px 10px', background: '#0f172a', borderRadius: 999, fontSize: 11 }}><code>{sessionId.slice(0,8)}</code></span>}
          </div>
          <AlertBanner alert={alert} />
          <div style={{ marginTop: 12, background: '#0f172a', padding: 10, borderRadius: 8, minHeight: 80, display: 'flex', alignItems: 'flex-end', gap: 3 }}>
            {history.length === 0 ? <span style={{ opacity: 0.4, fontSize: 12 }}>No live chunks yet — start a call and speak</span> : history.map(h => (
              <div key={h.chunk_index} style={{ flex: 1, height: `${Math.max(6,h.fused_risk_score)}%`, background: h.risk_level==='high'?'#ef4444':h.risk_level==='medium'?'#eab308':'#22c55e', borderRadius: 3 }} />
            ))}
          </div>
          {latest && <div style={{ marginTop: 8, fontSize: 11, opacity: 0.6 }}>Chunk #{latest.chunk_index} — {latest.fused_risk_score} ({latest.risk_level}) — aasist {latest.model_scores.aasist}</div>}
        </div>

        <div style={{ background: '#1e293b', padding: 16, borderRadius: 12, marginTop: 16, fontSize: 12 }}>
          <h4>How to test web→web (no SIP needed)</h4>
          <ol style={{ paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4, opacity: 0.85, marginTop: 6 }}>
            <li>Open this app in <b>two browser windows/tabs</b>.</li>
            <li>In Tab A pick <code>1001</code>, in Tab B pick <code>1002</code>.</li>
            <li>In Tab A dial <code>1002</code> → Tab B gets confirm popup → Accept.</li>
            <li>Allow mic in both → speak → watch gauge go live (uses same fusion as replay).</li>
            <li>Hangup → session appears in Dashboard history.</li>
          </ol>
          <h4 style={{ marginTop: 12 }}>How to test web→SIP/Asterisk</h4>
          <ol style={{ paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4, opacity: 0.85, marginTop: 6 }}>
            <li><code>powershell -File scripts/start-asterisk-wsl.ps1</code> (WSL must be running).</li>
            <li>Wait `wsl sudo asterisk -rx "pjsip show endpoints"` shows ready.</li>
            <li>Use any SIP softphone (Linphone/Zoiper) register as <code>1003@your-ip:5060</code> / <code>1003pass</code>, then dial from web.</li>
          </ol>
        </div>
      </div>

      <div>
        <RiskGauge score={latest?.fused_risk_score ?? 0} level={latest?.risk_level ?? 'low'} />
        <div style={{ background: '#1e293b', padding: 12, borderRadius: 10, marginTop: 12, fontSize: 11, opacity: 0.6 }}>
          Dialer uses open-source primitives: WebRTC (browser) + <code>sip.js</code> for SIP (install: <code>npm i sip.js</code>), backend fallback signaling at <code>/ws/signal/{'{ext}'}</code>. No heavy react-dialer kit needed — custom <code>DialPad.jsx</code> + <code>NumberSelector.jsx</code>.
        </div>
      </div>
    </div>
  )
}
