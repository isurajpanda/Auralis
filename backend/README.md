# Voice Clone Guard — Backend

FastAPI single process (port **9000** — not 8000, see Windows note). Owns model inference, sessions, WebSocket, and optional WSL Asterisk bridge.

## What it does

- Loads AASIST, RawNet2, XLS-R once at startup (`app/main.py:1` lifespan) and exposes `predict(wav,sr)`.
  Pretrained detectors: NII AntiDeepfake (`app/models/antideepfake.py:1`), W2V2-AASIST ONNX
  (`app/models/w2v2_aasist.py:1`), DF Arena 500M best-effort (`app/models/df_arena.py:1`) —
  each returns `None` when unavailable so fusion renormalizes over the rest.
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
- `LOW_THRESHOLD=15`, `HIGH_THRESHOLD=70` (low calibrated on measured
  genuine ≤11.3 vs noisy-TTS ≥17.5; high catches toy-synth/phone-TTS)
- `REAL_WINDOW_SECONDS=4` (pretrained models score rolling 4s),
  `SMOOTHING_CHUNKS=3` (broadcast = mean of last 3),
  `ALERT_PERSIST_CHUNKS=2` (2 consecutive medium+ raw chunks alert)
- `FUSION_WEIGHT_AASIST=0.15`, `FUSION_WEIGHT_RAWNET2=0.2`, `FUSION_WEIGHT_XLSR=0.15`,
  `FUSION_WEIGHT_ANTIDEEPFAKE=0.5`, `FUSION_WEIGHT_W2V2_AASIST=0.15`, `FUSION_WEIGHT_DF_ARENA=0.2`
  (weights renormalize over models that return a score; unavailable models return `None`)
- `REAL_MODEL_ENABLED=true`, `REAL_MODEL_DEVICE=auto` (NII AntiDeepfake)
- `W2V2_AASIST_ENABLED=true` (Arena W2V2-AASIST ONNX, auto-downloads ~1.2 GB to `checkpoints/`)
- `DF_ARENA_ENABLED=true`, `DF_ARENA_DEVICE=auto`, `DF_ARENA_REPO=...` (best-effort; upstream
  repo is missing custom-code files so it stays out of the fusion until fixed)
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
- `checkpoints/anti-deepfake-small.safetensors` (~380 MB) — NII AntiDeepfake, auto-downloaded.
- `checkpoints/w2v2-aasist.onnx` (~1.2 GB) — SpeechAntiSpoofingBenchmarks W2V2-AASIST,
  auto-downloaded on first start. Runs on the RTX GPU via `onnxruntime-gpu`
  (~0.09 s/window vs ~0.9 s CPU; `W2V2_AASIST_DEVICE=cpu` forces CPU).
  Coexists with AntiDeepfake on the 4 GB card at ~2.6 GB VRAM steady.
  Weighted 0.15: safe on sample calls (genuine ≤22 low, cloned ~83 high)
  but uncalibrated on toy files — validate on real TTS/VC.
- DF Arena 500M (~1.7 GB) loads via transformers `trust_remote_code`; currently unavailable
  upstream (missing custom-code files) so it self-excludes from fusion.

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
