import base64
import io
import numpy as np
import soundfile as sf

from app.config import SAMPLE_RATE

try:
    import librosa
    HAS_LIBROSA = True
except ImportError:
    HAS_LIBROSA = False

def decode_base64_audio(b64_str: str) -> tuple[np.ndarray, int]:
    data = base64.b64decode(b64_str)
    buf = io.BytesIO(data)
    wav, sr = sf.read(buf, dtype='float32')
    if wav.ndim > 1:
        wav = np.mean(wav, axis=1)
    return wav, sr

def load_wav(path: str) -> tuple[np.ndarray, int]:
    wav, sr = sf.read(path, dtype='float32')
    if wav.ndim > 1:
        wav = np.mean(wav, axis=1)
    return wav, sr

def resample(wav: np.ndarray, orig_sr: int, target_sr: int = SAMPLE_RATE) -> np.ndarray:
    if orig_sr == target_sr:
        return wav
    if HAS_LIBROSA:
        return librosa.resample(wav, orig_sr=orig_sr, target_sr=target_sr)
    # fallback linear interpolation
    duration = len(wav) / orig_sr
    new_len = int(duration * target_sr)
    x_old = np.linspace(0, 1, len(wav))
    x_new = np.linspace(0, 1, new_len)
    return np.interp(x_new, x_old, wav).astype(np.float32)

def chunk_audio(wav: np.ndarray, sr: int, chunk_seconds: int = 2) -> list[np.ndarray]:
    chunk_len = int(sr * chunk_seconds)
    chunks = []
    for i in range(0, len(wav), chunk_len):
        chunk = wav[i:i+chunk_len]
        if len(chunk) < chunk_len * 0.5:
            # pad last small chunk or skip
            if len(chunk) < chunk_len * 0.25:
                break
            padded = np.zeros(chunk_len, dtype=np.float32)
            padded[:len(chunk)] = chunk
            chunk = padded
        chunks.append(chunk)
    return chunks

def normalize_waveform(wav: np.ndarray) -> np.ndarray:
    if np.max(np.abs(wav)) > 0:
        wav = wav / np.max(np.abs(wav)) * 0.9
    return wav.astype(np.float32)
