import { useEffect, useRef, useState, useCallback } from 'react'
import { RISK_WS } from '../lib/config.js'

export function useRiskSocket(sessionId) {
  const [history, setHistory] = useState([])
  const [latest, setLatest] = useState(null)
  const [alert, setAlert] = useState(null)
  const [connected, setConnected] = useState(false)
  const wsRef = useRef(null)

  const connect = useCallback(() => {
    if (!sessionId) return
    const url = RISK_WS(sessionId)
    const ws = new WebSocket(url)
    wsRef.current = ws
    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onerror = () => setConnected(false)
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'risk_update') {
          setLatest(msg)
          setHistory(prev => [...prev, msg])
        } else if (msg.type === 'alert') {
          setAlert(msg)
          // auto clear after 6s
          setTimeout(() => setAlert(null), 6000)
        }
      } catch {}
    }
    return () => ws.close()
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return
    setHistory([])
    setLatest(null)
    setAlert(null)
    const cleanup = connect()
    return () => {
      if (wsRef.current) wsRef.current.close()
      if (cleanup) cleanup()
    }
  }, [sessionId, connect])

  const clearAlert = () => setAlert(null)

  return { history, latest, alert, connected, clearAlert }
}
