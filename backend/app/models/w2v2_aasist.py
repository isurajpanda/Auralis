"""
True detection model — W2V2-AASIST (SpeechAntiSpoofingBenchmarks).

- Weights: SpeechAntiSpoofingBenchmarks / lab260, MIT license.
  wav2vec 2.0 XLS-R 300M front-end + AASIST graph-attention back-end,
  trained on ASVspoof2019 LA with RawBoost (Odyssey 2022, arXiv:2202.12233).
  Arena: 0.22% EER ASVspoof2019_LA, 11.22% InTheWild.
- Runtime: pre-exported ONNX (`w2v2-aasist.onnx` in the HF repo), so no
  fairseq/torch dependency — just `onnxruntime`. FP32, deterministic
  first-64600-sample (~4.04s @ 16kHz) window, tile-repeat if shorter
  (exactly the Arena scoring protocol).
- Output: 2-class logits, index 1 = bona fide (higher = more bona fide).
  predict() returns P(fake) in 0..1 via softmax, or None when
  disabled/unavailable so the pipeline falls back to the other models.

Env:
  W2V2_AASIST_ENABLED=true|false  (default true)
  W2V2_AASIST_DEVICE=auto|cpu|cuda (default auto = cuda when onnxruntime-gpu
                                   + torch CUDA are both available, else cpu)
  W2V2_AASIST_PATH=...            (default: checkpoints/w2v2-aasist.onnx,
                                   auto-downloaded from HuggingFace if missing)

Checkpoint resolution: local file first, else auto-download from HuggingFace
(CACHED in `checkpoints/` so offline machines work after first fetch).
"""
import os
import threading

import numpy as np

REPO_ID = "SpeechAntiSpoofingBenchmarks/W2V2-AASIST"
REPO_FILENAME = "w2v2-aasist.onnx"
CHECKPOINT_PATH = os.path.join(os.path.dirname(__file__), "../../checkpoints/w2v2-aasist.onnx")

# Arena scoring window: deterministic first-64600-sample window @16kHz.
WINDOW_SAMPLES = 64600
NORM_ORDER_KEY = "w2v2_aasist"


def _enabled():
    return os.getenv("W2V2_AASIST_ENABLED", "true").lower() == "true"


def _want_cuda():
    return os.getenv("W2V2_AASIST_DEVICE", "auto").lower() in ("auto", "cuda")


def _cuda_available():
    """True only when ORT can actually run the CUDA EP (needs the CUDA 12 +
    cuDNN 9 DLLs, which torch already bundles — see _ensure_cuda_dlls)."""
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
    # system CUDA install. Registered for DLL search before session creation
    # (matters when this model loads before anything else touches torch).
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
    override = os.getenv("W2V2_AASIST_PATH", "").strip()
    local = os.path.abspath(override) if override else os.path.abspath(CHECKPOINT_PATH)
    if os.path.exists(local):
        return local
    try:
        from huggingface_hub import hf_hub_download
        print(f"[W2V2-AASIST] checkpoint missing, downloading {REPO_ID}/{REPO_FILENAME} ...")
        os.makedirs(os.path.dirname(local), exist_ok=True)
        tmp = hf_hub_download(repo_id=REPO_ID, filename=REPO_FILENAME)
        import shutil
        shutil.copyfile(tmp, local)
        print(f"[W2V2-AASIST] cached to {local}")
        return local
    except Exception as e:
        print(f"[W2V2-AASIST] download failed: {e}")
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


class _Model:
    def __init__(self):
        self.session = None
        self.input_name = None
        self.provider = "cpu"
        self._lock = threading.Lock()
        self._load()

    def _load(self):
        if not _enabled():
            print("[W2V2-AASIST] disabled via W2V2_AASIST_ENABLED=false")
            return
        path = _resolve_checkpoint()
        if not path:
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
            opts.log_severity_level = 3  # errors only (CUDA EP is chatty)
            self.session = ort.InferenceSession(path, sess_options=opts,
                                                providers=providers)
            self.input_name = self.session.get_inputs()[0].name
            self.provider = self.session.get_providers()[0]
            print(f"[W2V2-AASIST] ready (onnx on {self.provider}, "
                  f"input '{self.input_name}')")
        except Exception as e:
            print(f"[W2V2-AASIST] load failed ({e}); skipping this model")
            self.session = None

    def predict(self, waveform: np.ndarray, sample_rate: int):
        """P(fake) 0..1, or None when unavailable."""
        if self.session is None:
            return None
        try:
            wav = np.asarray(waveform, dtype=np.float32).ravel()
            if wav.size == 0:
                return None
            if sample_rate != 16000:
                from app.utils.audio import resample
                wav = resample(wav, sample_rate, 16000).astype(np.float32)
            # Live chunks are 2s; the Arena protocol windows to 64600 samples
            # (tile-repeat). Same deterministic window as the benchmark.
            x = pad_fixed(wav)[None, :]
            with self._lock:
                logits = self.session.run(None, {self.input_name: x})[0]
            logits = np.asarray(logits, dtype=np.float64).ravel()
            if logits.size == 2:
                # index 1 = bona fide -> softmax P(fake) = P(class 0)
                m = float(np.max(logits))
                e = np.exp(logits - m)
                return float(e[0] / np.sum(e))
            elif logits.size == 1:
                # single bona-fide logit -> P(fake) = 1 - sigmoid
                return float(1.0 / (1.0 + np.exp(logits[0])))
            else:
                print(f"[W2V2-AASIST] unexpected output shape {logits.shape}")
                return None
        except Exception as e:
            print(f"[W2V2-AASIST] inference failed: {e}")
            return None


_instance = None


def get_model():
    global _instance
    if _instance is None:
        _instance = _Model()
    return _instance


def predict(waveform: np.ndarray, sample_rate: int):
    return get_model().predict(waveform, sample_rate)
