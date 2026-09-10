"""
RawNet2 — real pretrained detector (ALLA1N clean-domain specialist, MIT).

- Weights: RawNet2 fine-tuned on ASVspoof2019 LA for clean-domain
  synthetic speech (`best_model.pth`, full training checkpoint — only
  `model_state_dict` is used). Architecture: SincConv front-end +
  residual blocks + GRU (Eurecom config, 25.4M params, verified zero
  missing/unexpected keys).
- Runtime: torch (CUDA when available, else CPU). Deterministic
  first-64600-sample window, tile-repeat if shorter (training `pad()`).
- Output: softmax `is_test=True`, index 1 = bona fide (per training
  `produce_evaluation_file`: score = out[:, 1], bonafide key = 1).
  predict() returns P(fake) = 1 - out[1].
- Falls back to the tuned periodicity heuristic when unavailable, so the
  pipeline never breaks. `.loaded` is True only for the real model.

Env:
  RAWNET2_ENABLED=true|false   (default true)
  RAWNET2_DEVICE=auto|cpu|cuda (default auto = CUDA when available)
  RAWNET2_PATH=...             (default: checkpoints/rawnet2-la-clean.pth,
                                auto-downloaded from HuggingFace if missing)
"""
import copy
import os
import threading

import numpy as np

REPO_ID = "ALLA1N/rawnet2-la-clean-specialist"
REPO_FILENAME = "best_model.pth"
CHECKPOINT_PATH = os.path.join(os.path.dirname(__file__), "../../checkpoints/rawnet2-la-clean.pth")

# Eurecom RawNet2 LA config (matches the fine-tune exactly).
D_ARGS = {
    "filts": [128, [128, 128], [128, 512], [512, 512]],
    "first_conv": 128,
    "in_channels": 1,
    "gru_node": 1024,
    "nb_gru_layer": 3,
    "nb_fc_node": 1024,
    "nb_classes": 2,
}

WINDOW_SAMPLES = 64600
NORM_ORDER_KEY = "rawnet2"


def _enabled():
    return os.getenv("RAWNET2_ENABLED", "true").lower() == "true"


def _device():
    want = os.getenv("RAWNET2_DEVICE", "auto").lower()
    if want == "cpu":
        return "cpu"
    if want == "cuda":
        return "cuda"
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _resolve_checkpoint():
    override = os.getenv("RAWNET2_PATH", "").strip()
    local = os.path.abspath(override) if override else os.path.abspath(CHECKPOINT_PATH)
    if os.path.exists(local):
        return local
    try:
        from huggingface_hub import hf_hub_download
        print(f"[RawNet2] checkpoint missing, downloading {REPO_ID}/{REPO_FILENAME} ...")
        os.makedirs(os.path.dirname(local), exist_ok=True)
        tmp = hf_hub_download(repo_id=REPO_ID, filename=REPO_FILENAME)
        import shutil
        shutil.copyfile(tmp, local)
        print(f"[RawNet2] cached to {local}")
        return local
    except Exception as e:
        print(f"[RawNet2] download failed: {e}")
        return None


def pad_fixed(wav: np.ndarray, length: int = WINDOW_SAMPLES) -> np.ndarray:
    """Training pad(): first `length` samples; tile-repeat if shorter."""
    wav = np.asarray(wav, dtype=np.float32).ravel()
    if wav.size == 0:
        return np.zeros(length, dtype=np.float32)
    if wav.size >= length:
        return wav[:length]
    repeats = int(length / wav.size) + 1
    return np.tile(wav, repeats)[:length]


def heuristic_score(waveform: np.ndarray, sample_rate: int) -> float:
    """Tuned periodicity heuristic (previous implementation, fallback)."""
    if len(waveform) == 0:
        return 0.0
    wav = waveform.astype(np.float64)
    wav = wav - np.mean(wav)
    n = len(wav)
    rms = float(np.sqrt(np.mean(wav ** 2)))
    if rms < 0.015:
        return 0.03
    wav_norm = wav / (np.std(wav) + 1e-10)
    power = np.abs(np.fft.rfft(wav_norm)) ** 2
    corr = np.fft.irfft(power, n=n)
    corr = corr / (corr[0] + 1e-10)
    lag = sample_rate // 200  # ~80 samples at 16k (5ms pitch period)
    if len(corr) > lag + 200:
        peak = float(np.max(corr[lag:lag + 200]))
    else:
        peak = 0.0
    windowed = wav * np.hamming(n)
    spectrum = np.abs(np.fft.rfft(windowed))
    freqs = np.fft.rfftfreq(n, d=1 / sample_rate)
    centroid = np.sum(freqs * spectrum) / (np.sum(spectrum) + 1e-10)
    hop = max(1, n // 10)
    energies = []
    for i in range(0, n - hop, hop):
        seg = wav[i:i + hop]
        energies.append(np.mean(seg ** 2))
    if energies:
        energies = np.array(energies)
        mean_e = np.mean(energies)
        cv2 = np.var(energies) / (mean_e ** 2 + 1e-12)
        var_norm = 1 - np.clip(cv2 * 2.5, 0, 1)
    else:
        cv2 = 0.0
        var_norm = 0.5
    centroid_spoof = 1.0 - np.clip((centroid - 1000) / 3000, 0, 1)
    peak_spoof = np.clip((peak - 0.96) * 25, 0, 1)
    score = 0.45 * peak_spoof + 0.35 * var_norm + 0.2 * centroid_spoof
    if peak > 0.995 and cv2 < 0.02:
        score = min(1.0, score + 0.2)
    score = float(np.clip(score, 0.02, 0.98))
    return score


class RawNet2Model:
    def __init__(self):
        self.net = None
        self.device = "cpu"
        self.loaded = False  # True only for the real torch model
        self._lock = threading.Lock()
        self._load()

    def _load(self):
        if not _enabled():
            print("[RawNet2] disabled via RAWNET2_ENABLED=false, heuristic fallback")
            return
        path = _resolve_checkpoint()
        if not path:
            print("[RawNet2] no checkpoint, heuristic fallback")
            return
        try:
            import torch
            from app.models.rawnet2_net import RawNet
            self.device = _device()
            net = RawNet(copy.deepcopy(D_ARGS), self.device)
            ckpt = torch.load(path, map_location="cpu")
            sd = ckpt.get("model_state_dict", ckpt) if isinstance(ckpt, dict) else ckpt
            missing, unexpected = net.load_state_dict(sd, strict=False)
            if missing or unexpected:
                print(f"[RawNet2] partial load (missing={len(missing)} unexpected={len(unexpected)})")
            net.to(self.device)
            net.eval()
            self.net = net
            self.loaded = True
            n = sum(p.numel() for p in net.parameters()) / 1e6
            print(f"[RawNet2] ready (torch {n:.1f}M params on {self.device})")
        except Exception as e:
            print(f"[RawNet2] load failed ({e}); heuristic fallback")
            self.net = None

    def predict(self, waveform: np.ndarray, sample_rate: int) -> float:
        """P(fake) 0..1 — real torch model, heuristic fallback."""
        if self.net is not None:
            try:
                import torch
                wav = np.asarray(waveform, dtype=np.float32).ravel()
                if wav.size == 0:
                    return 0.0
                if sample_rate != 16000:
                    from app.utils.audio import resample
                    wav = resample(wav, sample_rate, 16000).astype(np.float32)
                x = pad_fixed(wav)[None, :]
                with self._lock:
                    with torch.no_grad():
                        out = self.net(torch.from_numpy(x).to(self.device),
                                       is_test=True)
                proba = out[0, 1].detach().float().cpu().item()  # index 1 = bona fide
                return float(np.clip(1.0 - proba, 0.0, 1.0))
            except Exception as e:
                print(f"[RawNet2] inference failed: {e}, heuristic fallback")
        return heuristic_score(np.asarray(waveform), sample_rate)


_model = None


def get_model():
    global _model
    if _model is None:
        _model = RawNet2Model()
    return _model


def predict(waveform: np.ndarray, sample_rate: int) -> float:
    return get_model().predict(waveform, sample_rate)
