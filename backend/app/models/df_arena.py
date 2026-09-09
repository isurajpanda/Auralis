"""
True detection model — DF Arena 500M (SpeechAntiSpoofingBenchmarks).

- Weights: SpeechAntiSpoofingBenchmarks RAPTOR universal anti-spoofing model
  (arXiv:2603.06164). XLS-R 300M front-end + layer-attention pooling +
  4-block Conformer head, 2-way classifier. Arena mean EER 5.09% over
  24 datasets (1.87% InTheWild). FP32, deterministic first-64600-sample
  (~4.04s @ 16kHz) window, tile-repeat if shorter.
- Runtime: HuggingFace `transformers` with `trust_remote_code=True`
  (custom `antispoofing` pipeline / AutoModel defined by the repo).
- Output: label `bonafide`|`spoof` + scores. predict() returns P(fake)
  in 0..1, or None when disabled/unavailable so the pipeline falls back
  to the other models.

NOTE (2026-09): the upstream repo currently publishes only
`pytorch_model.bin` + `config.json` + `backbone.py` — the custom-code files
referenced by its own `auto_map` (`modeling_antispoofing.py`,
`configuration_antispoofing.py`, `feature_extraction_antispoofing.py`,
`pipeline_antispoofing.py`, `conformer.py`) are missing, so
`trust_remote_code` loading fails. This module therefore loads
best-effort: it tries, logs the exact reason on failure, and the fusion
renormalizes over the remaining models. As soon as upstream (or a fork)
publishes the missing files, set DF_ARENA_REPO to that repo id — no code
change needed.

Env:
  DF_ARENA_ENABLED=true|false  (default true)
  DF_ARENA_DEVICE=auto|cuda|cpu (default auto)
  DF_ARENA_REPO=...            (default: SpeechAntiSpoofingBenchmarks/DF_Arena_500M_V_1)
"""
import os
import threading

import numpy as np

DEFAULT_REPO_ID = "SpeechAntiSpoofingBenchmarks/DF_Arena_500M_V_1"
WINDOW_SAMPLES = 64600
NORM_ORDER_KEY = "df_arena"


def _enabled():
    return os.getenv("DF_ARENA_ENABLED", "true").lower() == "true"


def _repo_id():
    return os.getenv("DF_ARENA_REPO", DEFAULT_REPO_ID).strip() or DEFAULT_REPO_ID


def _device():
    want = os.getenv("DF_ARENA_DEVICE", "auto").lower()
    if want in ("cuda", "cpu"):
        return want
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _pad_fixed(wav: np.ndarray, length: int = WINDOW_SAMPLES) -> np.ndarray:
    """Arena windowing: first `length` samples; tile-repeat if shorter."""
    wav = np.asarray(wav, dtype=np.float32).ravel()
    if wav.size == 0:
        return np.zeros(length, dtype=np.float32)
    if wav.size >= length:
        return wav[:length]
    repeats = int(np.ceil(length / wav.size))
    return np.tile(wav, repeats)[:length]


class _Model:
    def __init__(self):
        self.pipe = None
        self.unavailable_reason = "not loaded"
        self._lock = threading.Lock()
        self._load()

    def _load(self):
        if not _enabled():
            self.unavailable_reason = "disabled via DF_ARENA_ENABLED=false"
            print(f"[DF-Arena] {self.unavailable_reason}")
            return
        repo = _repo_id()
        try:
            from transformers import pipeline
            device = _device()
            # transformers pipeline device: int (-1 = cpu) or "cuda:0"/"cpu".
            dev = 0 if device == "cuda" else -1
            print(f"[DF-Arena] loading {repo} on {device} ...")
            self.pipe = pipeline("antispoofing", model=repo,
                                 trust_remote_code=True, device=dev)
            print(f"[DF-Arena] ready on {device}")
        except Exception as e:
            self.unavailable_reason = str(e)[:300]
            print(f"[DF-Arena] load failed; skipping this model: {e}")
            self.pipe = None

    def predict(self, waveform: np.ndarray, sample_rate: int):
        """P(fake) 0..1, or None when unavailable."""
        if self.pipe is None:
            return None
        try:
            wav = np.asarray(waveform, dtype=np.float32).ravel()
            if wav.size == 0:
                return None
            if sample_rate != 16000:
                from app.utils.audio import resample
                wav = resample(wav, sample_rate, 16000).astype(np.float32)
            x = _pad_fixed(wav)
            with self._lock:
                out = self.pipe(x)
            # Expected: {'label': 'bonafide'|'spoof', 'all_scores': {...}}
            if isinstance(out, dict):
                scores = out.get("all_scores") or {}
                if scores:
                    # find the spoof-class score (label 0 = spoof per config)
                    for k, v in scores.items():
                        if str(k).lower() in ("spoof", "fake", "0"):
                            return float(v)
                    vals = list(scores.values())
                    # assume [spoof, bonafide] ordering
                    return float(vals[0])
                label = str(out.get("label", "")).lower()
                score = out.get("score", None)
                if score is not None:
                    s = float(score)
                    return s if label in ("spoof", "fake") else 1.0 - s
            return None
        except Exception as e:
            print(f"[DF-Arena] inference failed: {e}")
            return None


_instance = None


def get_model():
    global _instance
    if _instance is None:
        _instance = _Model()
    return _instance


def predict(waveform: np.ndarray, sample_rate: int):
    return get_model().predict(waveform, sample_rate)
