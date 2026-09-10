"""
AASIST — real pretrained detector (SpeechAntiSpoofingBenchmarks, MIT).

- Weights: official clovaai/aasist ASVspoof2019 LA checkpoint, exported to
  ONNX (`aasist.onnx`), 0.3M params. Arena: 0.83% EER ASVspoof2019_LA.
- Runtime: onnxruntime (CPU or CUDA), no torch needed. Deterministic
  first-64600-sample window, tile-repeat if shorter (Arena protocol).
- Output: 2-class logits, index 1 = bona fide (verified empirically:
  bonafide.wav -> +3.6, cloned.wav -> -8.5). predict() returns P(fake)
  in 0..1 via softmax.
- Falls back to the tuned spectral heuristic when the checkpoint is
  unavailable, so the pipeline never breaks. `.loaded` is True only for
  the real model (health endpoint reports honestly).

Env:
  AASIST_ENABLED=true|false   (default true)
  AASIST_DEVICE=auto|cpu|cuda (default auto = CUDA when ORT has the EP)
  AASIST_PATH=...             (default: checkpoints/aasist.onnx,
                               auto-downloaded from HuggingFace if missing)

Checkpoint resolution: local file first, else auto-download from HuggingFace
(CACHED in `checkpoints/` so offline machines work after first fetch).
"""
import os
import threading

import numpy as np

REPO_ID = "SpeechAntiSpoofingBenchmarks/AASIST"
REPO_FILENAME = "aasist.onnx"
CHECKPOINT_PATH = os.path.join(os.path.dirname(__file__), "../../checkpoints/aasist.onnx")

# Arena scoring window: deterministic first-64600-sample window @16kHz.
WINDOW_SAMPLES = 64600
NORM_ORDER_KEY = "aasist"


def _enabled():
    return os.getenv("AASIST_ENABLED", "true").lower() == "true"


def _want_cuda():
    return os.getenv("AASIST_DEVICE", "auto").lower() in ("auto", "cuda")


def _cuda_available():
    try:
        import onnxruntime as ort
        if "CUDAExecutionProvider" not in ort.get_available_providers():
            return False
    except Exception:
        return False
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def _ensure_cuda_dlls():
    # torch's bundled CUDA/cuDNN DLLs make the ORT CUDA EP work with no
    # system CUDA install.
    try:
        import torch
        lib = os.path.join(os.path.dirname(torch.__file__), "lib")
        if os.path.isdir(lib):
            try:
                os.add_dll_directory(lib)
            except Exception:
                pass
    except Exception:
        pass


def _resolve_checkpoint():
    override = os.getenv("AASIST_PATH", "").strip()
    local = os.path.abspath(override) if override else os.path.abspath(CHECKPOINT_PATH)
    if os.path.exists(local):
        return local
    try:
        from huggingface_hub import hf_hub_download
        print(f"[AASIST] checkpoint missing, downloading {REPO_ID}/{REPO_FILENAME} ...")
        os.makedirs(os.path.dirname(local), exist_ok=True)
        tmp = hf_hub_download(repo_id=REPO_ID, filename=REPO_FILENAME)
        import shutil
        shutil.copyfile(tmp, local)
        print(f"[AASIST] cached to {local}")
        return local
    except Exception as e:
        print(f"[AASIST] download failed: {e}")
        return None


def pad_fixed(wav: np.ndarray, length: int = WINDOW_SAMPLES) -> np.ndarray:
    """Arena windowing: first `length` samples; tile-repeat if shorter."""
    wav = np.asarray(wav, dtype=np.float32).ravel()
    if wav.size == 0:
        return np.zeros(length, dtype=np.float32)
    if wav.size >= length:
        return wav[:length]
    repeats = int(np.ceil(length / wav.size))
    return np.tile(wav, repeats)[:length]


def heuristic_score(waveform: np.ndarray, sample_rate: int) -> float:
    """
    Tuned spectral heuristic (previous implementation, kept as fallback):
    synthetic voice tends to have lower spectral flatness (too clean) and
    more periodic structure. Tuned on data/sample-calls/{bonafide,cloned}.wav.
    Returns spoof probability 0-1.
    """
    if len(waveform) == 0:
        return 0.0
    wav = waveform.astype(np.float64)
    wav = wav - np.mean(wav)
    # Silence/room-tone gate: near-silence is not a clone.
    rms = float(np.sqrt(np.mean(wav ** 2)))
    if rms < 0.015:
        return 0.03
    n = len(wav)
    windowed = wav * np.hamming(n)
    spectrum = np.abs(np.fft.rfft(windowed))
    spectrum = spectrum + 1e-10
    geom = np.exp(np.mean(np.log(spectrum)))
    arith = np.mean(spectrum)
    flatness = geom / (arith + 1e-10)  # 0..1, noisy ~ higher
    flatness_score = 1.0 - flatness  # 0..1, low flatness => synthetic

    freqs = np.fft.rfftfreq(n, d=1 / sample_rate)
    total_energy = np.sum(spectrum ** 2)
    hf_mask = (freqs > 2000) & (freqs < 8000)
    hf_energy = np.sum(spectrum[hf_mask] ** 2)
    hf_ratio = hf_energy / (total_energy + 1e-10)

    zcr = np.mean(np.abs(np.diff(np.sign(wav)))) / 2  # ~0-1
    zcr_spoof = float(np.clip((0.045 - zcr) / 0.02, 0, 1))
    hf_spoof = 1.0 - min(hf_ratio * 30.0, 1.0)
    score = 0.5 * flatness_score + 0.3 * zcr_spoof + 0.2 * hf_spoof
    if flatness < 0.05:
        score = min(1.0, score + 0.25)
    score = float(np.clip(score, 0.02, 0.98))
    return score


class AASISTModel:
    def __init__(self):
        self.session = None
        self.input_name = None
        self.provider = "cpu"
        self.loaded = False  # True only for the real ONNX model
        self._lock = threading.Lock()
        self._load()

    def _load(self):
        if not _enabled():
            print("[AASIST] disabled via AASIST_ENABLED=false, heuristic fallback")
            return
        path = _resolve_checkpoint()
        if not path:
            print("[AASIST] no checkpoint, heuristic fallback")
            return
        try:
            import onnxruntime as ort
            use_cuda = _want_cuda() and _cuda_available()
            if use_cuda:
                _ensure_cuda_dlls()
            providers = (["CUDAExecutionProvider", "CPUExecutionProvider"]
                         if use_cuda else ["CPUExecutionProvider"])
            opts = ort.SessionOptions()
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            opts.log_severity_level = 3
            self.session = ort.InferenceSession(path, sess_options=opts,
                                                providers=providers)
            self.input_name = self.session.get_inputs()[0].name
            self.provider = self.session.get_providers()[0]
            self.loaded = True
            print(f"[AASIST] ready (onnx on {self.provider}, "
                  f"input '{self.input_name}')")
        except Exception as e:
            print(f"[AASIST] load failed ({e}); heuristic fallback")
            self.session = None

    def predict(self, waveform: np.ndarray, sample_rate: int) -> float:
        """P(fake) 0..1 — real ONNX model, heuristic fallback."""
        if self.session is not None:
            try:
                wav = np.asarray(waveform, dtype=np.float32).ravel()
                if wav.size == 0:
                    return 0.0
                if sample_rate != 16000:
                    from app.utils.audio import resample
                    wav = resample(wav, sample_rate, 16000).astype(np.float32)
                x = pad_fixed(wav)[None, :]
                with self._lock:
                    logits = self.session.run(None, {self.input_name: x})[0]
                logits = np.asarray(logits, dtype=np.float64).ravel()
                if logits.size == 2:
                    # index 1 = bona fide -> softmax P(fake) = P(class 0)
                    m = float(np.max(logits))
                    e = np.exp(logits - m)
                    return float(e[0] / np.sum(e))
                print(f"[AASIST] unexpected output shape {logits.shape}")
            except Exception as e:
                print(f"[AASIST] inference failed: {e}, heuristic fallback")
        return heuristic_score(np.asarray(waveform), sample_rate)


# Singleton
_model = None


def get_model():
    global _model
    if _model is None:
        _model = AASISTModel()
    return _model


def predict(waveform: np.ndarray, sample_rate: int) -> float:
    return get_model().predict(waveform, sample_rate)
