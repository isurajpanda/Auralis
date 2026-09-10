from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import os

from app.routes.calls import router as calls_router
from app.routes.health import router as health_router
from app.routes.signaling import router as signaling_router
from app.sessions.session_manager import init_db
from app.ws.risk_socket import manager

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("[Startup] Initializing DB...")
    init_db()
    print("[Startup] Loading models once at startup...")
    try:
        from app.models.aasist import get_model as get_aasist
        from app.models.rawnet2 import get_model as get_rawnet
        from app.models.xlsr import get_model as get_xlsr
        from app.models.antideepfake import get_model as get_real
        from app.models.w2v2_aasist import get_model as get_w2v2
        from app.models.df_arena import get_model as get_arena
        get_aasist()
        get_rawnet()
        get_xlsr()
        for name, fn in (("antideepfake", get_real), ("w2v2_aasist", get_w2v2),
                         ("df_arena", get_arena)):
            try:
                fn()  # each is optional; falls back to other models if unavailable
            except Exception as e:
                print(f"[Startup] {name} skipped: {e}")
        print("[Startup] Models loaded")
    except Exception as e:
        print(f"[Startup] Model loading error: {e}")
    # WSL Asterisk: nothing to auto-start via Docker
    # For WSL mode, start Asterisk manually: powershell -File scripts/start-asterisk-wsl.ps1  (or wsl sudo service asterisk start)
    yield
    print("[Shutdown] App shutting down")

app = FastAPI(title="Voice Clone Guard", lifespan=lifespan)

# CORS for frontend
allow_origins = os.getenv("ALLOW_ORIGINS", "*")
origins = ["*"] if allow_origins == "*" else [o.strip() for o in allow_origins.split(",")]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router, prefix="")
app.include_router(calls_router, prefix="/api")
app.include_router(signaling_router, prefix="")

@app.get("/")
async def root():
    return {"service": "voice-clone-guard", "docs": "/docs"}

@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    await manager.connect(session_id, websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
            else:
                # Handle live audio chunks sent as JSON {type:"audio_chunk", pcm_b64, chunk_index, sample_rate}
                try:
                    import json, base64
                    msg = json.loads(data)
                    if msg.get("type") == "audio_chunk":
                        pcm_b64 = msg.get("pcm_b64", "")
                        idx = msg.get("chunk_index", 0)
                        sr = msg.get("sample_rate", 16000)
                        if pcm_b64:
                            pcm = base64.b64decode(pcm_b64)
                            from app.sip.asterisk_bridge import handle_live_audio_chunk
                            await handle_live_audio_chunk(session_id, idx, pcm, sr)
                        else:
                            print(f"[WS] empty audio_chunk sid={session_id[:8]} idx={idx}")
                except Exception as e:
                    print(f"[WS] audio_chunk parse failed sid={session_id[:8]}: {e}")
    except WebSocketDisconnect:
        manager.disconnect(session_id, websocket)
    except Exception as e:
        print(f"[WS] Error for {session_id}: {e}")
        manager.disconnect(session_id, websocket)
