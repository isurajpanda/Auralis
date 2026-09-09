# Handoff — Voice Clone Guard (SIH26104)

This doc is the single source of truth for what was built, what's working, what's not, and how to continue. Read it before touching code.

> **No git repo.** This project is not under version control (`not a git repository`).
> There is no history to restore from — do not reference "git history" anywhere.
> Consider `git init` + first commit if snapshots are ever needed.

## 1) System overview (current)

```
Browser  ──https://x.lan/──▶  nginx 1.30.4 (C:\Users\estac\Desktop\Auralis\nginx-1.30.4)
  │                              ├─ /               → frontend build (html/)
  │                              ├─ /api/*, /health, /docs → FastAPI 127.0.0.1:9000
  │                              ├─ /ws/*           → FastAPI websockets (risk + signaling)
  │                              ├─ /ari/*          → Asterisk 127.0.0.1:8088 (WSL, optional)
  │                              └─ /asterisk/ws    → Asterisk WS (WSL, optional)
  │
  ├─ mic (RAW: no echo/noise/gain processing) ──2s int16 chunks──▶ /ws/{session_id}
  └─ WebRTC peer call via /ws/signal/{ext} + STUN (no Asterisk needed)
```

- **Backend:** FastAPI, `backend/`, uvicorn `--reload --port 9000 --host 0.0.0.0`.
  `app/main.py` lifespan inits SQLite + preloads all 4 models.
- **Frontend:** Vite React 18, `frontend/`. Dev: `npm run dev` (:5173).
  Prod: `npm run build` = `vite build && node scripts/deploy-nginx.js`
  (copies `dist/` → `nginx-1.30.4/html/`, prunes stale hashed bundles, keeps
  `50x.html`). Served at `https://x.lan/` — never use `dist/` directly.
- **Config:** backend runtime config = `backend/.env` (copied from
  `.env.example`; **uvicorn --reload does NOT watch `.env` — restart backend
  after editing it**). Frontend env = `frontend/.env`
  (`VITE_BACKEND_URL=https://x.lan`, `VITE_SIP_WS_URL`, `VITE_SIP_DOMAIN`).
- **Hosts/Cert:** `x.lan → 127.0.0.1` in Windows hosts file; self-signed
  `nginx/conf/certs/x.lan.{crt,key}`, trusted in Root store (see
  `scripts/run-xlan.ps1`). Hyper-V reserves ports 7971–8070 → backend must
  stay on 9000. Machine: 16 GB RAM, CUDA GPU present (torch 2.6+cu124).

## 2) Detection pipeline (what's real now)

**Models** (`backend/app/models/`), all feed `replay_engine.process_chunk`
via `asyncio.to_thread`, fused in `fusion.py` → 0–100 + level
(`config.py`: low <30, medium <70, high ≥70):

| model | type | weight | note |
|---|---|---|---|
| `aasist.py` | heuristic (flatness/ZCR/HF) | 0.15 | silence gate (RMS<0.015 → 0.03) |
| `rawnet2.py` | heuristic (periodicity/energy/centroid) | 0.2 | FFT autocorr (was O(n²) `np.correlate`, ~5.5s/chunk → ~0s); relative energy variation (level-invariant) |
| `xlsr.py` | heuristic (entropy/jitter/rolloff) | 0.15 | jitter-weighted; silence gate |
| `antideepfake.py` | **REAL pretrained**: NII AntiDeepfake wav2vec2-small-NDA | 0.5 | fairseq-exact torch reimpl (no fairseq dep), 212/212 tensors strict-loaded, softmax P(fake) |

- **Real model details:** `nii-yamagishilab/wav2vec-small-anti-deepfake-nda`
  (HF), license **CC BY-NC-SA 4.0 (non-commercial — demo/research only)**,
  trained on ~18k hrs fake + ~56k hrs real. Checkpoint
  `backend/checkpoints/anti-deepfake-small.safetensors` (380 MB, **gitignored**;
  auto-downloads from HF if missing). Env: `REAL_MODEL_ENABLED` (default true),
  `REAL_MODEL_DEVICE` (auto = cuda if available else cpu). `predict()` returns
  `None` when unavailable → pipeline falls back to heuristics (weights
  renormalize automatically). Thread lock around CUDA forward.
- **Measured (2026-09-09, live WS path):** real speech **5.1 low**
  (real model: 0.000), cloned **95.9 high** (real: 0.999), silence **3–16 low**,
  ~0.1 s/chunk (was 5.7 s), pytest 6/6 in ~1 s.
- **Sample data:** `backend/data/sample-calls/bonafide.wav` = REAL LibriSpeech
  utterance (replaced the old synthetic sine on 2026-09-09 — the old file
  correctly scored 0.999 fake under the real model); `cloned.wav` = synthetic.
- **Chunk protocol:** frontend POSTs `/api/calls/start {mode:live}` → opens
  `/ws/{session_id}` (listener, `hooks/useRiskSocket.js`) + second WS uploading
  `{type:"audio_chunk", pcm_b64 (int16 mono), chunk_index, sample_rate:16000}`
  every 2 s (AudioWorklet `mic-chunker` in `hooks/useSip.js`, downsampled
  main-thread). Backend `main.py:/ws/{session_id}` → `handle_live_audio_chunk`
  → `process_chunk` → broadcasts `risk_update` (+ `alert` on high).
  Muted mic skips upload (never scores silence-as-signal).

## 3) Calls (WebRTC + signaling sync)

- **Signaling:** `/ws/signal/{ext}` (`backend/app/routes/signaling.py` +
  `ws/signaling.py`). Messages: `offer`/`answer`/`ice`/`hangup`. Backend
  attaches `from` and relays the **full message once** (a previous version
  double-relayed a stripped hangup — fixed).
- **Hangup reasons** (`ended|declined|busy|cancelled|failed`) survive the relay
  and drive UI copy (`Declined`, `Busy`, `No answer`, `Missed call from X`,
  `Ended by other side`, `Connection lost`).
- **Sync guarantees** (`frontend/src/hooks/useSip.js`): busy auto-reject when
  already in a call; 30 s no-answer timeout cancels both sides; `failed`
  peer-connection treated as remote hangup; `onConnected` resets the call timer
  on both sides (timer = connected time, not ring time); shared `finishCall`
  teardown ends the risk session + logs recents on local AND remote ends.
- **SIP/Asterisk (optional):** `asterisk/config/` (pjsip/extensions/http/ari/
  rtp/logger.conf), ext 1001–1005, ARI `voice-guard`, WSL via
  `scripts/setup-asterisk-wsl.sh` / `start-asterisk-wsl.ps1`. `sipClient.js`
  (sip.js) exists but the dialer uses backend signaling by default.

## 4) Frontend — dialer app (dark only)

Samsung-style dialer (`src/App.jsx`, no router — old `pages/` + `components/`
files are **dead code, safe to delete**):

- **Keypad / Recents** tabs (mobile); **dual-pane** (keypad + recents) on PC
  ≥900 px. `bootstrap-icons` only — no emoji. Physical keyboard support
  (digits/Backspace/Enter/Esc).
- **Identity sheet:** pick 1001–1005 (Alice…Eve). Quick-dial chips, redial.
- **Call screen:** avatar, timer, secure pill (`Call secured`/`Unusual`/
  `Suspicious`, amber `Listening…` until first score), **threat-score card**
  (0–100 + bar), **caller volume line** (remote-stream analyser, 10 Hz),
  mute/speaker/keypad, accept/decline vs hangup.
- **Audio UX** (`src/lib/ringtones.js`, WebAudio-synthesized, no files):
  ringback 440+480 Hz (caller), double-burst 700+900 Hz ringer (callee),
  triple 880 Hz beep on high threat + 12 s repeat. Singleton players,
  autoplay-policy resume handling.
- **Recents:** localStorage log (peer/duration/risk/note, tap-to-call) +
  server history from `GET /api/calls`, refresh + clear.
- Key files: `App.jsx`, `hooks/useSip.js` (signaling + upload + meter),
  `hooks/useRiskSocket.js`, `lib/config.js`, `lib/ringtones.js`,
  `scripts/deploy-nginx.js` (`NGINX_HTML_DIR` override, `build-only` to skip).

## 5) Launchers & cheat sheet

```powershell
cd C:\Users\estac\Desktop\Auralis\voice-clone-guard

# Preferred: full x.lan stack (hosts+cert check, build→nginx, backend job, nginx, optional asterisk)
powershell -ExecutionPolicy Bypass -File scripts\run-xlan.ps1
#   -NoAsterisk  -SkipBuild  -Stop

# Older dev launcher (vite :5173 + backend :9000, no nginx deploy)
powershell -ExecutionPolicy Bypass -File scripts\run-all.ps1

# Manual
cd backend;  python -m uvicorn app.main:app --reload --port 9000 --host 0.0.0.0
cd frontend; npm install; npm run dev      # :5173 dev
npm run build                               # prod → nginx html (auto)

# Verify
curl.exe -k -s https://x.lan/health        # {"status":"ok","models_loaded":[...]}
curl.exe -k -s https://x.lan/ | Select-String "assets/index-"
cd backend; python -m pytest -q            # 6 passed, ~1s
```

**Restart backend after editing `backend/.env`.** Check `voice_guard.db`
(gitignored) and `frontend/dist` (gitignored) are never committed; neither is
`checkpoints/*.safetensors` (380 MB).

## 6) Known limitations (honest, do not oversell)

- Heuristics remain in the blend (50%); the real model carries the decision.
  Real-model behavior validated on: LibriSpeech (0.000 fake), our synthetic
  files (0.999), silence (0.42, →low after fusion), MP3 roundtrip (robust).
  **No ElevenLabs/real-clone file has been scored yet** — top validation gap.
- Acoustic path: speaker→mic playback loses fidelity; browser mic processing
  is forced OFF for this reason, but room re-recording still degrades artifacts
  vs direct-file scoring (no upload endpoint exists yet).
- Paper evaluates 4 s+ windows; we score 2 s chunks (measured fine, but noted).
- Thresholds 30/70 are heuristic-era; paper's In-the-Wild EER threshold is
  ~0.95 — per-domain calibration still open.
- ARI/Snoop tap for real SIP audio not implemented (`asterisk_bridge` only
  handles WS-uploaded PCM). No WS/signaling pytest coverage. Dead frontend
  files (`pages/`, old `components/`) still in tree. No git repo. Volume meter
  needs flowing remote audio (0 until peer media arrives).

## 7) How to continue

**Immediate:**
1. **Restart backend** to apply the new `backend/.env` fusion weights
   (0.15/0.2/0.15/0.5 → expect ~5 low / ~96 high; running instance still uses
   old 0.4/0.3/0.3/0.5 until restarted).
2. Retest live with ElevenLabs audio through speakers (raw mic now passes it
   through). If it still scores low, drop the file into
   `backend/data/sample-calls/` and score it directly — ground truth in seconds.
3. Two-tab call (1001→1002): confirm ringback/ringer, both screens move
   together on answer/hangup/decline, threat card goes live when speaking.

**Short-term:**
- `POST /api/calls/test-file` (multipart upload → same chunk pipeline) for
  one-click file testing without the acoustic path.
- pytest for signaling WS + `audio_chunk` roundtrip (currently only manual).
- Delete dead `frontend/src/{pages,components}` (keep `hooks lib App main css`).
- `git init` + first commit (with checkpoint/DB/dist ignored).

**Mid-term:**
- ARI Snoop/AudioSocket tap for real SIP-call audio.
- Threshold calibration per domain (real voice vs TTS garden test set).
- `FEATURE_ONLY_LOGGING` audit (scores only — already true, never audio).
