import asyncio
import os
import numpy as np
import soundfile as sf

from app.config import (REPLAY_CHUNK_SECONDS, SAMPLE_RATE, HIGH_THRESHOLD,
                        REAL_WINDOW_SECONDS, SMOOTHING_CHUNKS, ALERT_PERSIST_CHUNKS,
                        risk_level)
from app.utils.audio import resample, chunk_audio
from app.sessions.session_manager import add_score, get_call
from app.ws.risk_socket import manager
from app.fusion import fuse_scores

# To avoid circular import, import predict lazily inside function

# Per-session rolling state (replay + live share process_chunk).
# _buffers: resampled 16k mono tail feeding the pretrained (4s-native) models.
# _fused_hist: recent raw fused scores for temporal smoothing.
# _level_hist: recent raw levels for alert persistence.
_buffers: dict[str, np.ndarray] = {}
_fused_hist: dict[str, list[float]] = {}
_level_hist: dict[str, list[str]] = {}


def append_window(buf: np.ndarray | None, chunk: np.ndarray, want: int) -> np.ndarray:
    """Pure helper: append a chunk to the rolling tail, capped at `want` samples."""
    buf = chunk if buf is None else np.concatenate([buf, chunk])
    return buf[-want:] if len(buf) > want else buf


def smooth_score(hist: list[float], value: float, n: int) -> float:
    """Pure helper: rolling mean of the last `n` values (mutates `hist`)."""
    hist.append(value)
    if len(hist) > n:
        hist.pop(0)
    return float(sum(hist) / len(hist))


def sustained_medium(levels: list[str], level: str, n: int) -> bool:
    """Pure helper: True when the last `n` raw levels are all medium+."""
    levels.append(level)
    if len(levels) > n:
        levels.pop(0)
    return len(levels) >= n and all(l in ("medium", "high") for l in levels)


def _window_for_session(session_id: str, chunk_16k: np.ndarray) -> np.ndarray:
    want = int(SAMPLE_RATE * REAL_WINDOW_SECONDS)
    buf = append_window(_buffers.get(session_id), chunk_16k, want)
    _buffers[session_id] = buf
    return buf


def end_session_cleanup(session_id: str):
    """Free rolling state; called when a call ends (replay finish or API end)."""
    _buffers.pop(session_id, None)
    _fused_hist.pop(session_id, None)
    _level_hist.pop(session_id, None)


async def process_chunk(session_id: str, chunk_index: int, waveform: np.ndarray, sr: int):
    # Run inference in thread pool to not block event loop
    from app.models import aasist, rawnet2, xlsr, antideepfake, w2v2_aasist, df_arena
    # Resolve singletons HERE (event-loop thread), not inside workers:
    # checkpoint/file loading (torch/safetensors/onnx) is not safe to run
    # for the first time concurrently in a worker thread.
    m_aasist = aasist.get_model()
    m_rawnet2 = rawnet2.get_model()
    m_xlsr = xlsr.get_model()
    m_real = antideepfake.get_model()
    m_w2v2 = w2v2_aasist.get_model()
    m_arena = df_arena.get_model()
    # Normalize once: 16k mono float32. Heuristics score the 2s chunk;
    # pretrained detectors score the rolling 4s window (their native
    # operating point — 2s slices flip-flop, see HANDOFF TTS validation).
    chunk = np.asarray(waveform, dtype=np.float32).ravel()
    if sr != SAMPLE_RATE:
        chunk = resample(chunk, sr, SAMPLE_RATE).astype(np.float32)
    window = _window_for_session(session_id, chunk)
    target_sr = SAMPLE_RATE
    # Heuristics are instant; the three pretrained detectors run alongside
    # them via to_thread (ORT CUDA + torch GPU/CPU each hold their own lock).
    (aasist_score, rawnet2_score, xlsr_score,
     real_score, w2v2_score, arena_score) = await asyncio.gather(
        asyncio.to_thread(m_aasist.predict, chunk, target_sr),
        asyncio.to_thread(m_rawnet2.predict, chunk, target_sr),
        asyncio.to_thread(m_xlsr.predict, chunk, target_sr),
        asyncio.to_thread(m_real.predict, window, target_sr),
        asyncio.to_thread(m_w2v2.predict, window, target_sr),
        asyncio.to_thread(m_arena.predict, window, target_sr),
    )
    model_scores = {
        "aasist": round(float(aasist_score), 4),
        "rawnet2": round(float(rawnet2_score), 4),
        "xlsr": round(float(xlsr_score), 4)
    }
    # Real pretrained detectors. Each is skipped silently when unavailable
    # -> remaining models carry the score via renormalized weights.
    if real_score is not None:
        model_scores["antideepfake"] = round(float(real_score), 4)
    if w2v2_score is not None:
        model_scores["w2v2_aasist"] = round(float(w2v2_score), 4)
    if arena_score is not None:
        model_scores["df_arena"] = round(float(arena_score), 4)
    raw_fused, raw_level = fuse_scores(model_scores)
    raw_fused = round(float(raw_fused), 1)
    # Temporal smoothing: rolling mean over the last SMOOTHING_CHUNKS raw
    # scores. The broadcast/persisted value is the smoothed one (the acted
    # value); raw is attached for transparency/debugging.
    hist = _fused_hist.setdefault(session_id, [])
    fused = round(smooth_score(hist, raw_fused, SMOOTHING_CHUNKS), 1)
    level = risk_level(fused)
    ts = add_score(session_id, chunk_index, model_scores, fused, level)
    # Broadcast risk_update
    await manager.broadcast(session_id, {
        "type": "risk_update",
        "session_id": session_id,
        "chunk_index": chunk_index,
        "model_scores": model_scores,
        "fused_risk_score": fused,
        "raw_fused_risk_score": raw_fused,
        "risk_level": level,
        "timestamp": ts
    })
    # Alert on smoothed high, or on sustained medium+ (persistence catches
    # real TTS that hovers below the high line chunk after chunk).
    levels = _level_hist.setdefault(session_id, [])
    sustained = sustained_medium(levels, raw_level, ALERT_PERSIST_CHUNKS)
    if level == "high":
        await manager.broadcast(session_id, {
            "type": "alert",
            "session_id": session_id,
            "risk_level": "high",
            "message": "Possible cloned/synthetic voice detected. Recommend secondary verification."
        })
    elif sustained and level == "medium":
        await manager.broadcast(session_id, {
            "type": "alert",
            "session_id": session_id,
            "risk_level": "high",
            "message": "Sustained suspicious voice pattern over several chunks. Recommend secondary verification."
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
    end_session_cleanup(session_id)
    print(f"[Replay] Finished replay for {session_id}")

def start_replay_background(session_id: str, wav_path: str):
    # Called from route handler
    asyncio.create_task(replay_session(session_id, wav_path))
