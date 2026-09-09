// Central backend URL — x.lan via nginx 443 (all on 80/443). Same-origin when served by nginx.
// Override via VITE_BACKEND_URL if needed; default is https://x.lan
export const BACKEND_HTTP = import.meta.env.VITE_BACKEND_URL || 'https://x.lan'
export const BACKEND_WS = BACKEND_HTTP.replace(/^http/, 'ws')
export const SIGNAL_WS = (ext) => `${BACKEND_WS}/ws/signal/${ext}`
export const RISK_WS = (sessionId) => `${BACKEND_WS}/ws/${sessionId}`
// SIP / Asterisk — WSS via nginx proxy at wss://x.lan/asterisk/ws (proxies to 127.0.0.1:8088/ws)
export const SIP_WS_URL = import.meta.env.VITE_SIP_WS_URL || 'wss://x.lan/asterisk/ws'
export const SIP_DOMAIN = import.meta.env.VITE_SIP_DOMAIN || 'x.lan'
