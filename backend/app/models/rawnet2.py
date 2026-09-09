"""
RawNet2 wrapper — heuristic fallback
"""
import os
import numpy as np

CHECKPOINT_PATH = os.path.join(os.path.dirname(__file__), "../../checkpoints/rawnet2.pth")

class RawNet2Model:
    def __init__(self):
        self.loaded = False
        self.checkpoint_path = os.path.abspath(CHECKPOINT_PATH)
        self._load()

    def _load(self):
        if os.path.exists(self.checkpoint_path):
            try:
                import torch
                self.model = torch.load(self.checkpoint_path, map_location="cpu")
                self.loaded = True
                print(f"[RawNet2] Loaded checkpoint from {self.checkpoint_path}")
                return
            except Exception as e:
                print(f"[RawNet2] Failed to load checkpoint: {e}, using heuristic")
        print("[RawNet2] Using heuristic spoof detector (no checkpoint)")
        self.loaded = True

    def predict(self, waveform: np.ndarray, sample_rate: int) -> float:
        if len(waveform) == 0:
            return 0.0
        wav = waveform.astype(np.float64)
        wav = wav - np.mean(wav)
        n = len(wav)
        # Silence/room-tone gate: near-silence is not a clone.
        rms = float(np.sqrt(np.mean(wav ** 2)))
        if rms < 0.015:
            return 0.03
        # Autocorrelation peak (synthetic more periodic).
        # FFT-based O(n log n): the old np.correlate(mode='full') was O(n^2)
        # and took ~5.5s per 2s chunk, freezing live scores.
        wav_norm = wav / (np.std(wav) + 1e-10)
        power = np.abs(np.fft.rfft(wav_norm)) ** 2
        corr = np.fft.irfft(power, n=n)
        corr = corr / (corr[0] + 1e-10)
        lag = sample_rate // 200  # ~80 samples at 16k (5ms pitch period)
        if len(corr) > lag + 200:
            peak = float(np.max(corr[lag:lag + 200]))
        else:
            peak = 0.0

        # Spectral centroid (synthetic slightly higher due to artifacts)
        windowed = wav * np.hamming(n)
        spectrum = np.abs(np.fft.rfft(windowed))
        freqs = np.fft.rfftfreq(n, d=1/sample_rate)
        centroid = np.sum(freqs * spectrum) / (np.sum(spectrum) + 1e-10)
        centroid_norm = np.clip((centroid - 1000) / 3000, 0, 1)  # 1000-4000 Hz

        # Energy variation over time (synthetic more constant).
        # Relative variation (CV^2) so quiet speech scores like loud speech.
        hop = max(1, n // 10)
        energies = []
        for i in range(0, n - hop, hop):
            seg = wav[i:i+hop]
            energies.append(np.mean(seg**2))
        if energies:
            energies = np.array(energies)
            mean_e = np.mean(energies)
            cv2 = np.var(energies) / (mean_e ** 2 + 1e-12)
            var_norm = 1 - np.clip(cv2 * 2.5, 0, 1)  # steady energy => high spoof
        else:
            cv2 = 0.0
            var_norm = 0.5

        # Invert centroid: cloned has lower centroid (clean low harmonics) vs bonafide noisy high centroid
        centroid_spoof = 1.0 - np.clip((centroid - 1000) / 3000, 0, 1)
        # Periodicity only counts when very high (natural voiced speech wobbles
        # around ~0.9-0.98; only near-perfect steadiness flags synthetic)
        peak_spoof = np.clip((peak - 0.96) * 25, 0, 1)
        score = 0.45 * peak_spoof + 0.35 * var_norm + 0.2 * centroid_spoof
        # Boost if very periodic and steady energy (cloned signature)
        if peak > 0.995 and cv2 < 0.02:
            score = min(1.0, score + 0.2)
        score = float(np.clip(score, 0.02, 0.98))
        return score

_model = None
def get_model():
    global _model
    if _model is None:
        _model = RawNet2Model()
    return _model

def predict(waveform: np.ndarray, sample_rate: int) -> float:
    return get_model().predict(waveform, sample_rate)
