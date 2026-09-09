# Voice Clone Guard — Backend

FastAPI single process (port **9000** — not 8000, see Windows note). Owns model inference, sessions, WebSocket, and optional WSL Asterisk bridge.

## What it does

- Loads AASIST, RawNet2, XLS-R once at startup (`app/main.py:1` lifespan) and exposes `predict(wav,sr)`.
- Fuses via `app/fusion.py:1` (weights in `app/config.py:1`) → 0–100 + `risk_level`.
- Sessions in SQLite `voice_guard.db` (`app/sessions/session_manager.py:1`).
- REST + WS (`app/routes/calls.py:1`, `health.py:1`, `signaling.py:1`, `app/ws/risk_socket.py:1` + `signaling.py:1`).
- Replay (`app/replay/replay_engine.py:1`) + live chunk path (`app/sip/asterisk_bridge.py:1` → `handle_live_audio_chunk`).

## Prerequisites

- Python 3.10+ (3.13 tested), pip 23+, `libsndfile` (soundfile), `ffmpeg` optional, no DB server.

## Install

```bash
cd backend
pip install -r requirements.txt
# Windows:
copy .env.example .env
# macOS/Linux: cp .env.example .env
# Optional heavy:
# pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
# pip install transformers  # for XLSR HF
bash scripts/download_checkpoints.sh  # optional
```

> **Windows + Python 3.13 / port 8000:** Hyper-V reserves `7971-8070` → `8000` gives `10013`. Backend defaults to `9000` (`PORT=9000` in `.env.example`). Use `VITE_BACKEND_URL=http://localhost:9000` for frontend. `requirements.txt` is unpinned for cp313 wheels.

## How to run

```bash
# Native Windows (no Docker):
python -m uvicorn app.main:app --reload --port 9000
# health
curl http://localhost:9000/health
# docs
# http://localhost:9000/docs

# Or one-click (from repo root):
powershell -ExecutionPolicy Bypass -File scripts\run-all.ps1
powershell -ExecutionPolicy Bypass -File scripts\run-all.ps1 -BackendPort 9001  # if busy
```

## Env (.env.example)

- `PORT=9000`, `HOST=0.0.0.0`
- `LOW_THRESHOLD=30`, `HIGH_THRESHOLD=70`
- `FUSION_WEIGHT_AASIST=0.4`, `FUSION_WEIGHT_RAWNET2=0.3`, `FUSION_WEIGHT_XLSR=0.3`
- `FEATURE_ONLY_LOGGING=false`
- `REPLAY_CHUNK_SECONDS=2`, `DATABASE_URL=sqlite:///./voice_guard.db`, `ALLOW_ORIGINS=*`
- `XLSR_USE_HF=false` → `true` for HF `facebook/wav2vec2-xls-r-300m`
- **Asterisk/WSL:** `ENABLE_ASTERISK=false`, `ARI_URL=http://localhost:8088/ari`, `ARI_USER=voice-guard`, `ARI_PASS=voice-guard-secret`, `SIP_WS_URL=ws://localhost:8088/ws`

## API contract (same as spec, but on 9000)

- `POST /api/calls/start` `{mode:"replay"|"live", replay_sample:"bonafide"|"cloned"}` → `{session_id}`
- `POST /api/calls/{id}/end`, `GET /api/calls`, `GET /api/calls/{id}`
- `GET /health` → `{status, models_loaded}`
- `ws://localhost:9000/ws/{session_id}` → `risk_update` + `alert`
- `ws://localhost:9000/ws/signal/{ext}` → `offer/answer/ice/hangup/audio_chunk` (web↔web signaling, see `app/ws/signaling.py:1`)

Inference via `asyncio.to_thread`, same `process_chunk` for replay + live (`handle_live_audio_chunk`).

## Checkpoints

- `checkpoints/aasist.pth` / `rawnet2.pth` — from AASIST/ASVspoof repos. If missing, heuristic runs (see HANDOFF.md).

## Tests

```bash
pytest -q  # 6 passed
pytest -v tests/test_models.py tests/test_api.py
```

## WSL Asterisk (no Docker)

```powershell
powershell -File scripts\start-asterisk-wsl.ps1 -Install  # apt install asterisk + copy asterisk/config -> /etc/asterisk
powershell -File scripts\start-asterisk-wsl.ps1 -Status    # pjsip show endpoints
# From Windows: curl http://localhost:8088/ari/asterisk/info -u voice-guard:voice-guard-secret
# SIP WS ws://localhost:8088/ws  UDP 5060  extensions 1001-1005/1001pass
```

## Known Limitations

- Heuristic heads only until checkpoints/HF enabled.
- Live mic tapping via `AudioWorklet` not yet wired in `frontend/src/hooks/useSip.js:107`.
- No Docker — backend is native Windows.
