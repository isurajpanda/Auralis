# Voice Clone Guard — AI-Powered Real-Time Voice Clone / Impersonation Detection

**SIH26104 — AI-Powered Real-Time Detection and Prevention of Voice Cloning Impersonation Attacks**

One-paragraph summary: Voice Clone Guard is a real-time anti-spoofing system that ingests call audio in 2–4s chunks, scores each chunk with three independent models (AASIST, RawNet2, XLS-R) in parallel, fuses them into a 0–100 impersonation risk score, and streams the score live to a React dashboard over WebSocket with instant audible/visual alerts when the threshold is crossed. It is built as a single FastAPI backend plus a React frontend (now **Dialer** + **Dashboard**), with a replay fallback that makes the full pipeline demoable without any Asterisk/SIP setup — and optional **WSL Asterisk** for real SIP.

## Architecture

```
                ┌──────────────┐  REST /ws  ┌──────────────────────┐
                │   React      ├───────────►│  FastAPI (single     │
                │  :5173 Dialer│ WebSocket  │  process, :9000)     │
                │      Dashboard◄───────────┤  • models/ (A,R,X)   │
                └──────┬───────┘  signal    │  • fusion.py         │
                       │  SIP.js   /ws/signal│  • sessions → SQLite │
                       │  WebRTC   /ws/{id} │  • replay_engine     │
                       └───────────────────►│  • asterisk_bridge   │
                       ┌──────────────┐      │  • ws/signaling      │
                       │ WSL Asterisk │◄─────┤  ARI 8088            │
                       │ 5060/8088    │      └──────────────────────┘
                       └──────────────┘
```

Flow: `replay wav OR live mic PCM → chunk 2s → asyncio.to_thread(predict) ×3 → fuse → persist → broadcast risk_update → gauge + alert`

## Quickstart

### Option A — One-click (WSL Asterisk + backend + frontend)

```powershell
cd C:\Users\estac\Desktop\Auralis\voice-clone-guard
copy backend\.env.example backend\.env   # once, set ENABLE_ASTERISK=true if using WSL ARI
powershell -ExecutionPolicy Bypass -File scripts\run-all.ps1
# -> http://localhost:5173  Dialer=/  Dashboard=/dashboard
# -> http://localhost:9000/health  {"status":"ok"}
# -> http://localhost:9000/docs

# WSL Asterisk only (once, ~2 min):
powershell -ExecutionPolicy Bypass -File scripts\start-asterisk-wsl.ps1 -Install
# Status: powershell -File scripts\start-asterisk-wsl.ps1 -Status
# Stop all: powershell -File scripts\run-all.ps1 -Stop
```

### Option B — Manual (no Asterisk, pure replay)

```powershell
# 1. Backend (Windows — run from repo root)
cd voice-clone-guard\backend
pip install -r requirements.txt
copy .env.example .env
python -m uvicorn app.main:app --reload --port 9000
# -> http://localhost:9000/health
# If 9000 busy (Hyper-V reserves 7971-8070 including 8000): use --port 9001 and set VITE_BACKEND_URL

# 2. Frontend (second terminal)
cd voice-clone-guard\frontend
npm install
npm run dev
# -> http://localhost:5173
```

> **Windows + Python 3.13 note:** `requirements.txt` is unpinned (no `numpy==1.26.4`/`torch==2.2.0`) so `pip` fetches cp313 wheels. For heuristic demo you do **not** need `torch`. For real checkpoints: `pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu` + `pip install transformers`.

## Frontend — Dialer vs Dashboard

- **Dialer** (`src/pages/Dialer.jsx:1`, `/dialer`) — `NumberSelector` (1001–1005), `DialPad`, `useSip.js` (WebRTC via `ws://localhost:9000/ws/signal/{ext}` + STUN, fallback when Asterisk down; `lib/sipClient.js` for real SIP.js `UserAgent` when `ws://localhost:8088/ws` is up). Creates a live `POST /api/calls/start {mode:"live"}` session so `RiskGauge` streams same as replay.
- **Dashboard** (`src/pages/Dashboard.jsx:1`, `/dashboard`) — replay `CallPanel` (bonafide/cloned), live `RiskGauge`/`AlertBanner`, `CallHistory` chart, `useRiskSocket` (`ws://.../ws/{session_id}`).

Backend URL is centralized in `src/lib/config.js:1` (`VITE_BACKEND_URL || http://localhost:9000`).

## Demo Script (under 2 minutes, replay — zero WSL)

1. `powershell -File scripts\run-all.ps1 -NoAsterisk` → check `http://localhost:9000/health` = `{"models_loaded":["aasist","rawnet2","xlsr"]}`.
2. Open `http://localhost:5173/dashboard` → **Start Replay (Normal Voice)** → gauge ~54 medium, no alert. End Call.
3. **Start Replay (Cloned Voice)** → within 2–4s gauge → **88 red >70**, alert banner + chime. End Call → History → click session → per-model scores + chart.
4. Show `http://localhost:9000/docs` for API.

## Dialer demo (web↔web, no SIP)

1. Open two tabs `/dialer`: Tab A pick `1001`, Tab B pick `1002`.
2. Tab A dial `1002` → Tab B Accept → allow mic → speak → gauge streams live (same fusion).
3. Hangup → session appears in Dashboard history.

## WSL Asterisk demo (web↔SIP)

```powershell
powershell -File scripts\start-asterisk-wsl.ps1 -Install
# register any SIP softphone as 1003/1003pass@<host>:5060 and dial from Dialer
# ARI: http://localhost:8088/ari (voice-guard / voice-guard-secret)  SIP WS ws://localhost:8088/ws
```

## Repo Structure

- `backend/` — FastAPI single process (see `backend/README.md`)
- `frontend/` — React Vite (see `frontend/README.md`) — now with `pages/Dialer` + `Dashboard`, `lib/config.js`
- `asterisk/config/` — `pjsip.conf` (1001–1005), `extensions.conf` (echo 9196, Stasis 7000), `ari.conf`, `http.conf`, `rtp.conf` — copied to `/etc/asterisk` by `scripts/setup-asterisk-wsl.sh:1`
- `scripts/` — `setup-asterisk-wsl.sh`, `start-asterisk-wsl.ps1`, `run-all.ps1` — **no Docker**

## Known Limitations (honest)

- **XLS-R/AASIST/RawNet2 are heuristic** (`checkpoints/` empty) — set `XLSR_USE_HF=true` + `torch` for real HF. Not claimed as trained.
- **Sample WAVs synthetic** — not ASVspoof2021. Replace for eval.
- **Port 8000 is reserved** by Hyper-V `7971-8070` on this machine → backend uses `9000`.
- **Mic tapping** for live calls is stubbed (`useSip.js:107` AudioWorklet) — replay is guaranteed demo path.
- **SQLite** — swap to Postgres for prod.

## Credits / References

- AASIST — https://github.com/clovaai/aasist
- RawNet2 — https://github.com/asvspoof-challenge/2021
- XLS-R — `facebook/wav2vec2-xls-r-300m`
- ASVspoof2021 / SpeechFake, Asterisk, SIP.js, STUN `stun.l.google.com:19302`

## Tests

```bash
cd backend
pytest -q  # 6 passed (4 model separation + 2 API)  npm run build (frontend)
```

See `HANDOFF.md` for full handoff.
