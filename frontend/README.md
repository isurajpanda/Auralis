# Voice Clone Guard — Frontend

React 18 + Vite with **Dialer** (live web↔web / web↔SIP) + **Dashboard** (replay + risk gauge + history). Router via `react-router-dom`.

## What it does

- `pages/Dashboard.jsx:1` — replay `CallPanel` (`bonafide`/`cloned`), `RiskGauge`, `AlertBanner` (chime), `CallHistory` chart. Uses `hooks/useRiskSocket.js:1` (`ws://.../ws/{session_id}`) + `lib/config.js:1`.
- `pages/Dialer.jsx:1` — `NumberSelector` (1001–1005), `DialPad`, `hooks/useSip.js:1` (WebRTC via `ws://.../ws/signal/{ext}` + STUN, `lib/sipClient.js:1` for real SIP.js `UserAgent` when `ws://localhost:8088/ws` is up). Creates live `POST /api/calls/start {mode:"live"}` so gauge streams same pipeline.
- `lib/config.js:1` — `BACKEND_HTTP = VITE_BACKEND_URL || http://localhost:9000` (centralizes port — Windows Hyper-V reserves 8000) + `RISK_WS`/`SIGNAL_WS` helpers.
- `App.jsx:1` — `BrowserRouter` `/dialer` vs `/dashboard` (Dialer is default).

## Prerequisites

- Node 18+ / npm 9+

## Install

```bash
cd frontend
npm install  # pulls sip.js@0.20.0 + react-router-dom@6.22.3
```

## How to run

```bash
npm run dev
# -> http://localhost:5173  Dialer=/  Dashboard=/dashboard
# Backend must be on http://localhost:9000 (see backend/README.md)
# Override: VITE_BACKEND_URL=http://localhost:9001 npm run dev

# Build:
npm run build   # -> dist/  vite preview
```

Or one-click (from repo root):
```powershell
powershell -ExecutionPolicy Bypass -File scripts\run-all.ps1
```

## API it consumes

Via `lib/config.js:1` (`BACKEND_HTTP` = `http://localhost:9000`):

- `POST {BACKEND_HTTP}/api/calls/start`
- `GET {BACKEND_HTTP}/api/calls`, `GET {BACKEND_HTTP}/api/calls/{id}`
- `WS {BACKEND_WS}/ws/{session_id}` (risk) + `WS {BACKEND_WS}/ws/signal/{ext}` (WebRTC signaling)

SIP (WSL Asterisk):
- `ws://localhost:8088/ws` (PJSIP via `sipClient.js`), `http://localhost:8088/ari` (voice-guard), UDP `5060`, extensions `1001-1005/1001pass`, echo `9196`.

## Tests

No frontend unit tests — manual acceptance: `/dialer` 1001→1002 web↔web + `/dashboard` replay cloned→red gauge. `npm run build` passes (45 modules).

## Notes

- **Port 9000** — `8000` is in Hyper-V excluded range `7971-8070` on this host. All `8000` hardcodes were moved to `lib/config.js`.
- **No Docker** — frontend runs native (`npm run dev`). WSL Asterisk only if SIP needed (`scripts/start-asterisk-wsl.ps1`).
