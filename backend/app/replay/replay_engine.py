import asyncio
import os
import numpy as np
import soundfile as sf

from app.config import REPLAY_CHUNK_SECONDS, SAMPLE_RATE, HIGH_THRESHOLD
from app.utils.audio import resample, chunk_audio
from app.sessions.session_manager import add_score, get_call
from app.ws.risk_socket import manager
from app.fusion import fuse_scores

# To avoid circular import, import predict lazily inside function

async def process_chunk(session_id: str, chunk_index: int, waveform: np.ndarray, sr: int):
    # Run inference in thread pool to not block event loop
    from app.models import aasist, rawnet2, xlsr, antideepfake
    # Run in parallel via to_thread
    aasist_score, rawnet2_score, xlsr_score = await asyncio.gather(
        asyncio.to_thread(aasist.predict, waveform, sr),
        asyncio.to_thread(rawnet2.predict, waveform, sr),
        asyncio.to_thread(xlsr.predict, waveform, sr),
    )
    model_scores = {
        "aasist": round(float(aasist_score), 4),
        "rawnet2": round(float(rawnet2_score), 4),
        "xlsr": round(float(xlsr_score), 4)
    }
    # Real pretrained detector (NII AntiDeepfake). Skipped silently when
    # unavailable -> heuristics carry the score via renormalized weights.
    real_score = await asyncio.to_thread(antideepfake.predict, waveform, sr)
    if real_score is not None:
        model_scores["antideepfake"] = round(float(real_score), 4)
    fused, level = fuse_scores(model_scores)
    fused = round(float(fused), 1)
    ts = add_score(session_id, chunk_index, model_scores, fused, level)
    # Broadcast risk_update
    await manager.broadcast(session_id, {
        "type": "risk_update",
        "session_id": session_id,
        "chunk_index": chunk_index,
        "model_scores": model_scores,
        "fused_risk_score": fused,
        "risk_level": level,
        "timestamp": ts
    })
    # Alert if high
    if level == "high":
        await manager.broadcast(session_id, {
            "type": "alert",
            "session_id": session_id,
            "risk_level": "high",
            "message": "Possible cloned/synthetic voice detected. Recommend secondary verification."
        })

async def replay_session(session_id: str, wav_path: str):
    print(f"[Replay] Starting replay for {session_id} from {wav_path}")
    if not os.path.exists(wav_path):
        print(f"[Replay] File not found: {wav_path}")
        await manager.broadcast(session_id, {"type": "error", "message": f"Sample not found: {wav_path}"})
        return
    wav, sr = sf.read(wav_path, dtype='float32')
    if wav.ndim > 1:
        wav = np.mean(wav, axis=1)
    # Resample to target
    if sr != SAMPLE_RATE:
        wav = resample(wav, sr, SAMPLE_RATE)
        sr = SAMPLE_RATE
    chunks = chunk_audio(wav, sr, REPLAY_CHUNK_SECONDS)
    print(f"[Replay] {len(chunks)} chunks for {session_id}")
    for idx, chunk in enumerate(chunks):
        # Check if session still exists / not ended? We allow continue even if ended? but stop if call ended
        # Simple: if get_call ended_at is set, break? We'll check
        call = get_call(session_id)
        if call and call.get("ended_at"):
            print(f"[Replay] Session {session_id} ended, stopping replay at chunk {idx}")
            break
        await process_chunk(session_id, idx, chunk, sr)
        # Simulate real-time pacing: sleep chunk duration minus processing time approx
        await asyncio.sleep(REPLAY_CHUNK_SECONDS)
    print(f"[Replay] Finished replay for {session_id}")

def start_replay_background(session_id: str, wav_path: str):
    # Called from route handler
    asyncio.create_task(replay_session(session_id, wav_path))
