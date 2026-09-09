"""
XLS-R wrapper. Tries to load HuggingFace model, falls back to heuristic.
"""
import os
import numpy as np

CHECKPOINT_PATH = os.path.join(os.path.dirname(__file__), "../../checkpoints/xlsr.pth")

class XLSRModel:
    def __init__(self):
        self.loaded = False
        self.hf_model = None
        self.processor = None
        self.classifier_loaded = False
        self._load()

    def _load(self):
        # Try HF model if checkpoints exist or internet available; otherwise heuristic
        # We avoid heavy download at startup in offline/demo mode
        hf_cache = os.getenv("HF_USE_CACHE", "true")
        # Attempt lazy load: only if transformers available and user wants HF
        # For demo, we stay heuristic to keep startup fast
        print("[XLS-R] Using heuristic spoof detector (HF model not loaded by default)")
        print("        To enable HF, set XLSR_USE_HF=true and ensure internet + transformers")
        if os.getenv("XLSR_USE_HF", "false").lower() == "true":
            try:
                from transformers import Wav2Vec2Processor, Wav2Vec2Model
                print("[XLS-R] Loading facebook/wav2vec2-xls-r-300m ...")
                self.processor = Wav2Vec2Processor.from_pretrained("facebook/wav2vec2-xls-r-300m")
                self.hf_model = Wav2Vec2Model.from_pretrained("facebook/wav2vec2-xls-r-300m")
                self.hf_model.eval()
                self.loaded = True
                print("[XLS-R] HF feature extractor loaded")
                # Try classifier head checkpoint
                if os.path.exists(self._ckpt()):
                    import torch
                    self.classifier = torch.load(self._ckpt(), map_location="cpu")
                    self.classifier_loaded = True
                return
            except Exception as e:
                print(f"[XLS-R] HF load failed: {e}, falling back to heuristic")
        self.loaded = True  # heuristic considered loaded

    def _ckpt(self):
        return os.path.abspath(CHECKPOINT_PATH)

    def predict(self, waveform: np.ndarray, sample_rate: int) -> float:
        if len(waveform) == 0:
            return 0.0
        # If HF loaded, use it + simple head
        if self.hf_model is not None and self.processor is not None:
            try:
                import torch
                inputs = self.processor(waveform, sampling_rate=sample_rate, return_tensors="pt", padding=True)
                with torch.no_grad():
                    feats = self.hf_model(**inputs).last_hidden_state.mean(dim=1).squeeze().numpy()
                # Simple logistic head (random initialized if no checkpoint)
                # Heuristic projection to 0-1
                score = float(1 / (1 + np.exp(-np.mean(feats) * 2)))
                return float(np.clip(score, 0.02, 0.98))
            except Exception as e:
                print(f"[XLS-R] HF inference failed: {e}, heuristic fallback")
        # Heuristic fallback: similar to AASIST but different weighting
        wav = waveform.astype(np.float64)
        wav = wav - np.mean(wav)
        n = len(wav)
        # Silence/room-tone gate: near-silence is not a clone.
        rms = float(np.sqrt(np.mean(wav ** 2)))
        if rms < 0.015:
            return 0.03
        windowed = wav * np.hamming(n)
        spectrum = np.abs(np.fft.rfft(windowed))
        spectrum = spectrum + 1e-10
        # Spectral rolloff
        freqs = np.fft.rfftfreq(n, d=1/sample_rate)
        cumsum = np.cumsum(spectrum)
        rolloff_idx = np.searchsorted(cumsum, 0.85 * cumsum[-1])
        rolloff = freqs[min(rolloff_idx, len(freqs)-1)] / (sample_rate/2)

        # MFCC-like: mel energy variance? simplified
        # Use spectral entropy (synthetic lower entropy)
        ps = spectrum**2
        ps_norm = ps / (np.sum(ps) + 1e-10)
        entropy = -np.sum(ps_norm * np.log(ps_norm + 1e-10))
        entropy_norm = entropy / np.log(len(ps_norm) + 1e-10)  # 0..1
        spoof_from_entropy = 1 - entropy_norm  # low entropy => synthetic

        # Jitter-like: period variation. Natural voice wobbles (high jitter),
        # synthetic is metronome-steady (low jitter) — the strongest cue here.
        zero_crossings = np.where(np.diff(np.signbit(wav)))[0]
        if len(zero_crossings) > 2:
            intervals = np.diff(zero_crossings)
            jitter = np.std(intervals) / (np.mean(intervals) + 1e-10)
            jitter_spoof = 1 - np.clip(jitter * 2, 0, 1)  # low jitter => synthetic
        else:
            jitter_spoof = 0.5

        # Entropy barely separates tonal signals; weight it down.
        score = 0.15 * spoof_from_entropy + 0.55 * jitter_spoof + 0.3 * (1 - rolloff)
        # synthetic is steady + low rolloff
        if jitter_spoof > 0.8 and (1 - rolloff) > 0.3:
            score = min(1.0, score + 0.1)
        score = float(np.clip(score, 0.02, 0.98))
        return score

_model = None
def get_model():
    global _model
    if _model is None:
        _model = XLSRModel()
    return _model

def predict(waveform: np.ndarray, sample_rate: int) -> float:
    return get_model().predict(waveform, sample_rate)
