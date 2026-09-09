import os
from dotenv import load_dotenv

load_dotenv()

PORT = int(os.getenv("PORT", "8000"))
HOST = os.getenv("HOST", "0.0.0.0")

LOW_THRESHOLD = float(os.getenv("LOW_THRESHOLD", "30"))
MEDIUM_THRESHOLD = float(os.getenv("MEDIUM_THRESHOLD", "70"))
HIGH_THRESHOLD = float(os.getenv("HIGH_THRESHOLD", "70"))

FUSION_WEIGHTS = {
    # Heuristic tuning: periodicity/jitter cues (rawnet2/xlsr) separate
    # natural irregular speech from steady synthetic better than flatness.
    # The real pretrained detector carries half the weight when present;
    # when absent the three heuristic weights renormalize to the same blend.
    "aasist": float(os.getenv("FUSION_WEIGHT_AASIST", "0.15")),
    "rawnet2": float(os.getenv("FUSION_WEIGHT_RAWNET2", "0.2")),
    "xlsr": float(os.getenv("FUSION_WEIGHT_XLSR", "0.15")),
    "antideepfake": float(os.getenv("FUSION_WEIGHT_ANTIDEEPFAKE", "0.5")),
    # Arena true-detection models (each returns None when unavailable, so
    # absent models drop out and the remaining weights renormalize).
    "w2v2_aasist": float(os.getenv("FUSION_WEIGHT_W2V2_AASIST", "0.25")),
    "df_arena": float(os.getenv("FUSION_WEIGHT_DF_ARENA", "0.2")),
}

FEATURE_ONLY_LOGGING = os.getenv("FEATURE_ONLY_LOGGING", "false").lower() == "true"
REPLAY_CHUNK_SECONDS = int(os.getenv("REPLAY_CHUNK_SECONDS", "2"))
# Pretrained detectors score a rolling window of this many seconds (their
# native 4s operating point); heuristics always score the 2s chunk.
REAL_WINDOW_SECONDS = int(os.getenv("REAL_WINDOW_SECONDS", "4"))
# Temporal smoothing: fused score broadcast is the mean of the last N raw
# chunk scores; alerts also fire after N consecutive medium+ raw chunks.
SMOOTHING_CHUNKS = int(os.getenv("SMOOTHING_CHUNKS", "3"))
ALERT_PERSIST_CHUNKS = int(os.getenv("ALERT_PERSIST_CHUNKS", "2"))
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./voice_guard.db")
ALLOW_ORIGINS = os.getenv("ALLOW_ORIGINS", "*")

# Normalize weights to sum 1
_total = sum(FUSION_WEIGHTS.values())
if _total > 0:
    for k in FUSION_WEIGHTS:
        FUSION_WEIGHTS[k] /= _total

SAMPLE_RATE = 16000

def risk_level(score: float) -> str:
    if score < LOW_THRESHOLD:
        return "low"
    elif score < HIGH_THRESHOLD:
        return "medium"
    else:
        return "high"
