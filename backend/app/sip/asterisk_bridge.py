"""
Asterisk/ARI integration + WebRTC live audio tap.
Web-to-web uses direct WebRTC signaling; Asterisk path uses ARI Snoop/AudioSocket.
Both feed into replay_engine.process_chunk so dashboard sees same risk stream.
"""
import asyncio
import os
import base64
import json
import numpy as np

ENABLE_ASTERISK = os.getenv("ENABLE_ASTERISK", "false").lower() == "true"
ARI_URL = os.getenv("ARI_URL", "http://asterisk:8088/ari")
ARI_USER = os.getenv("ARI_USER", "voice-guard")
ARI_PASS = os.getenv("ARI_PASS", "voice-guard-secret")

async def start_asterisk_tap(session_id: str, ari_config: dict):
    """
    Placeholder for live SIP tapping.
    In production:
    - Connect to Asterisk ARI (ari-py or httpx)
    - Subscribe to Stasis, create Snoop channel or AudioSocket
    - For each incoming audio frame (slin16), buffer into chunks and call replay_engine.process_chunk
    """
    if not ENABLE_ASTERISK:
        print(f"[SIP] Asterisk disabled (ENABLE_ASTERISK=false). Using WebRTC direct path for {session_id}")
        from app.ws.risk_socket import manager
        await manager.broadcast(session_id, {
            "type": "alert",
            "session_id": session_id,
            "risk_level": "medium",
            "message": "Live WebRTC mode ready — pick a number in Dialer and call. Asterisk ARI disabled (set ENABLE_ASTERISK=true + docker compose up)."
        })
        return
    print(f"[SIP] Starting ARI tap for {session_id} via {ARI_URL}")
    # Real ARI flow (requires asterisk running):
    # 1. POST /ari/channels with app=voice-clone-guard
    # 2. Subscribe to StasisStart, create Snoop channel on bridged call
    # 3. Receive 16k slin frames via WebSocket, buffer 2s, call process_chunk
    try:
        import httpx
        async with httpx.AsyncClient(auth=(ARI_USER, ARI_PASS), timeout=5) as client:
            r = await client.get(f"{ARI_URL}/asterisk/info", params={"api_key": f"{ARI_USER}:{ARI_PASS}"})
            print(f"[ARI] ping {r.status_code}")
    except Exception as e:
        print(f"[ARI] not reachable: {e}")
    from app.ws.risk_socket import manager
    await manager.broadcast(session_id, {
        "type": "alert",
        "session_id": session_id,
        "risk_level": "medium",
        "message": "ARI tap attempted — check Asterisk logs if no audio."
    })

async def handle_live_audio_chunk(session_id: str, chunk_index: int, pcm_bytes: bytes, sample_rate: int = 16000):
    """Called by WebSocket audio upload (web→backend) or ARI frame callback."""
    # pcm_bytes is 16-bit mono
    try:
        waveform = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        from app.replay.replay_engine import process_chunk
        await process_chunk(session_id, chunk_index, waveform, sample_rate)
    except Exception as e:
        print(f"[LiveAudio] chunk failed {e}")

# Example ARI config template (document in README)
ARI_EXAMPLE = {
    "ari_url": "http://localhost:8088/ari",
    "username": "voice-guard",
    "password": "voice-guard-secret",
    "app_name": "voice-clone-guard"
}
