"""
Real pretrained deepfake detector — NII AntiDeepfake wav2vec2-small (NDA).

- Weights: Yamagishi Lab (NII), CC BY-NC-SA 4.0 (non-commercial, research/demo).
  Post-trained on ~18k hrs fake + ~56k hrs real speech (ASVspoof, MLAAD,
  WaveFake, vocoded corpora...). Paper: arXiv:2506.21090.
- Architecture: fairseq Wav2Vec2Model (base: 12 layers, 768 dim) + temporal
  average pooling + Linear(768 -> 2) [fake, real]. Reimplemented here in pure
  torch (no fairseq dependency) with EXACT fairseq module/key names, so the
  vendored safetensors loads with zero missing keys (asserted at load).
- Input: 16 kHz mono, arbitrary length, layer-normed per utterance.
- Output: P(fake) in 0..1 via softmax. Returns None when disabled/unavailable
  so the pipeline falls back to heuristics.

Env:
  REAL_MODEL_ENABLED=true|false   (default true)
  REAL_MODEL_DEVICE=cuda|cpu      (default: cuda if available else cpu)
  REAL_MODEL_PATH=...             (default: checkpoints/anti-deepfake-small.safetensors)

Checkpoint resolution: local file first, else auto-download from HuggingFace
(CACHED in `checkpoints/` so nginx/offline machines work after first fetch).
"""
import os
import threading

import numpy as np

REPO_ID = "nii-yamagishilab/wav2vec-small-anti-deepfake-nda"
CHECKPOINT_PATH = os.path.join(os.path.dirname(__file__), "../../checkpoints/anti-deepfake-small.safetensors")

N_HEADS = 12
EMB_DIM = 768
FFN_DIM = 3072
N_LAYERS = 12
NORM_ORDER_KEY = "antideepfake"


def _enabled():
    return os.getenv("REAL_MODEL_ENABLED", "true").lower() == "true"


def _device():
    want = os.getenv("REAL_MODEL_DEVICE", "auto").lower()
    if want in ("cuda", "cpu"):
        return want
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _resolve_checkpoint():
    local = os.path.abspath(CHECKPOINT_PATH)
    if os.path.exists(local):
        return local
    # Fall back to HuggingFace download, cached into checkpoints/
    try:
        from huggingface_hub import hf_hub_download
        print(f"[AntiDeepfake] checkpoint missing, downloading {REPO_ID} ...")
        os.makedirs(os.path.dirname(local), exist_ok=True)
        tmp = hf_hub_download(repo_id=REPO_ID, filename="model.safetensors")
        import shutil
        shutil.copyfile(tmp, local)
        print(f"[AntiDeepfake] cached to {local}")
        return local
    except Exception as e:
        print(f"[AntiDeepfake] download failed: {e}")
        return None


def _build_modules():
    import torch.nn as nn

    class SamePad(nn.Module):
        # fairseq SamePad: conv padding k//2 overshoots by 1 when k is even
        def __init__(self, k):
            super().__init__()
            self.trim = 1 if k % 2 == 0 else 0

        def forward(self, x):
            return x[:, :, :-self.trim] if self.trim else x

    class FeatureExtractor(nn.Module):
        # fairseq ConvFeatureExtractionModel, mode="default", conv_bias=False:
        # layer 0 = Conv+GELU with GroupNorm, layers 1-6 = Conv+GELU.
        # Keys: feature_extractor.conv_layers.{i}.{0=conv, 2=norm}.*
        def __init__(self):
            super().__init__()
            dims = [(512, 10, 5)] + [(512, 3, 2)] * 4 + [(512, 2, 2)] + [(512, 2, 2)]
            blocks = nn.ModuleList()
            in_d = 1
            for i, (dim, k, stride) in enumerate(dims):
                conv = nn.Conv1d(in_d, dim, k, stride=stride, bias=False)
                if i == 0:
                    blocks.append(nn.Sequential(
                        conv, nn.Dropout(p=0.0),
                        nn.GroupNorm(dim, dim, affine=True), nn.GELU()))
                else:
                    blocks.append(nn.Sequential(
                        conv, nn.Dropout(p=0.0), nn.GELU()))
                in_d = dim
            self.conv_layers = blocks

        def forward(self, x):
            x = x.unsqueeze(1)  # BxT -> Bx1xT
            for blk in self.conv_layers:
                x = blk(x)
            return x  # BxCxT

    # NOTE: the attention block is rebuilt with fairseq-exact names inside
    # DeepfakeDetector below; only SamePad + FeatureExtractor are shared.
    return SamePad, FeatureExtractor


class DeepfakeDetector:
    """Holds torch modules built with fairseq-exact names for strict loading."""

    def __init__(self, device):
        import torch
        import torch.nn as nn
        SamePad, FeatureExtractor = _build_modules()
        self.torch = torch
        self.device = device

        self.feat = FeatureExtractor()
        self.post_proj = nn.Linear(512, EMB_DIM)
        self.pre_ln = nn.LayerNorm(512)
        pos_conv = nn.Conv1d(EMB_DIM, EMB_DIM, kernel_size=128,
                             padding=64, groups=16)
        pos_conv = nn.utils.weight_norm(pos_conv, name="weight", dim=2)
        self.pos_conv = nn.Sequential(pos_conv, SamePad(128), nn.GELU())
        self.enc_ln = nn.LayerNorm(EMB_DIM)

        # Rebuild attention layers with fairseq-exact attribute names.
        import torch.nn.functional as F

        class Layer(nn.Module):
            def __init__(lself):
                super().__init__()
                lself.self_attn = nn.Module()
                lself.self_attn.q_proj = nn.Linear(EMB_DIM, EMB_DIM)
                lself.self_attn.k_proj = nn.Linear(EMB_DIM, EMB_DIM)
                lself.self_attn.v_proj = nn.Linear(EMB_DIM, EMB_DIM)
                lself.self_attn.out_proj = nn.Linear(EMB_DIM, EMB_DIM)
                lself.self_attn_layer_norm = nn.LayerNorm(EMB_DIM)
                lself.fc1 = nn.Linear(EMB_DIM, FFN_DIM)
                lself.fc2 = nn.Linear(FFN_DIM, EMB_DIM)
                lself.final_layer_norm = nn.LayerNorm(EMB_DIM)

            def forward(lself, x, key_mask):
                residual = x
                B, H, T, d = x.size(1), N_HEADS, x.size(0), EMB_DIM // N_HEADS
                q = lself.self_attn.q_proj(x).view(T, B, H, d).permute(1, 2, 0, 3)
                k = lself.self_attn.k_proj(x).view(T, B, H, d).permute(1, 2, 0, 3)
                v = lself.self_attn.v_proj(x).view(T, B, H, d).permute(1, 2, 0, 3)
                a = F.scaled_dot_product_attention(q, k, v, attn_mask=key_mask,
                                                   dropout_p=0.0)
                a = a.permute(2, 0, 1, 3).reshape(T, B, EMB_DIM)
                x = residual + lself.self_attn.out_proj(a)
                x = lself.self_attn_layer_norm(x)
                residual = x
                x = lself.fc2(F.gelu(lself.fc1(x)))
                x = residual + x
                return lself.final_layer_norm(x)

        self.layers = nn.ModuleList([Layer() for _ in range(N_LAYERS)])
        self.proj_fc = nn.Linear(EMB_DIM, 2)
        self.pool = nn.AdaptiveAvgPool1d(1)

        # Map our module tree onto fairseq key prefixes for loading.
        # (mask_emb / quantizer / project_q / final_proj exist in the
        # checkpoint but are unused in features_only inference → skipped.)
        self._prefix_map = [
            ("feat.conv_layers.", "feature_extractor.conv_layers."),
            ("post_proj.", "post_extract_proj."),
            ("pre_ln.", "layer_norm."),
            ("pos_conv.", "encoder.pos_conv."),
            ("enc_ln.", "encoder.layer_norm."),
            ("proj_fc.", "proj_fc."),
        ]

    def state_dict(self):
        import torch
        sd = {}
        mods = [("feat.", self.feat), ("post_proj.", self.post_proj),
                ("pre_ln.", self.pre_ln), ("pos_conv.", self.pos_conv),
                ("enc_ln.", self.enc_ln), ("proj_fc.", self.proj_fc)]
        for prefix, mod in mods:
            for k, v in mod.state_dict().items():
                sd[prefix + k] = v
        for i, layer in enumerate(self.layers):
            for k, v in layer.state_dict().items():
                sd[f"layers.{i}.{k}"] = v
        return sd

    def load_safetensors(self, path):
        from safetensors import safe_open
        own = self.state_dict()
        missing, loaded = [], 0
        with safe_open(path, framework="pt") as f:
            for ckey in f.keys():
                if not ckey.startswith("m_ssl.model."):
                    if ckey in ("proj_fc.weight", "proj_fc.bias"):
                        own["proj_fc." + ckey.split(".")[1]].copy_(f.get_tensor(ckey))
                        loaded += 1
                    continue
                rest = ckey[len("m_ssl.model."):]
                ours = None
                if rest.startswith("encoder.layers."):
                    # checkpoint: encoder.layers.{i}.*  ->  ours: layers.{i}.*
                    ours = "layers." + rest[len("encoder.layers."):]
                else:
                    for mine, theirs in self._prefix_map:
                        if rest.startswith(theirs):
                            ours = mine + rest[len(theirs):]
                            break
                if ours is not None and ours in own:
                    own[ours].copy_(f.get_tensor(ckey))
                    loaded += 1
                elif ours is not None:
                    missing.append((ckey, ours))
        if missing:
            raise RuntimeError(f"[AntiDeepfake] {len(missing)} tensors unmapped, e.g. {missing[:5]}")
        print(f"[AntiDeepfake] loaded {loaded} tensors from {path}")
        return loaded

    def to_eval(self):
        for m in (self.feat, self.post_proj, self.pre_ln, self.pos_conv,
                  self.enc_ln, self.layers, self.proj_fc):
            m.to(self.device).eval()
        return self

    @staticmethod
    def _pad_mask(B, H, L, pad, device, dtype):
        # Explicit (B, H, L, S) additive mask (-inf = ignore pad frames).
        import torch
        if pad <= 0:
            return None
        m = torch.zeros(B, H, L, L, device=device, dtype=dtype)
        m[..., -pad:] = float("-inf")
        return m

    def forward_logits(self, wav_b11):
        import torch
        x = wav_b11.to(self.device)  # (B, T)
        h = self.feat(x)             # (B, 512, T')
        h = h.transpose(1, 2)        # (B, T', 512)
        h = self.pre_ln(h)
        h = self.post_proj(h)        # (B, T', 768)
        T = h.size(1)
        pad = (-T) % 2               # required_seq_len_multiple = 2
        if pad:
            h = torch.cat([h, torch.zeros(h.size(0), pad, h.size(2),
                                          device=h.device)], dim=1)
        xc = self.pos_conv(h.transpose(1, 2)).transpose(1, 2)
        h = h + xc
        h = self.enc_ln(h)
        h = h.transpose(0, 1)        # (T, B, C)
        mask = self._pad_mask(1, 12, h.size(0), pad, h.device, h.dtype)
        for layer in self.layers:
            h = layer(h, mask)
        h = h.transpose(0, 1)        # (B, T, C)
        if pad:
            h = h[:, :-pad]
        pooled = self.pool(h.transpose(1, 2)).squeeze(-1)
        return self.proj_fc(pooled)  # (B, 2) [fake, real]


class _Model:
    def __init__(self):
        self.det = None
        self.device = _device()
        self._lock = threading.Lock()
        self._load()

    def _load(self):
        if not _enabled():
            print("[AntiDeepfake] disabled via REAL_MODEL_ENABLED=false")
            return
        path = _resolve_checkpoint()
        if not path:
            return
        try:
            import torch
            det = DeepfakeDetector(self.device)
            det.load_safetensors(path)
            det.to_eval()
            self.det = det
            print(f"[AntiDeepfake] ready on {self.device}")
        except Exception as e:
            print(f"[AntiDeepfake] load failed ({e}); heuristics only")
            self.det = None

    def predict(self, waveform: np.ndarray, sample_rate: int):
        """P(fake) 0..1, or None when unavailable."""
        if self.det is None or len(waveform) == 0:
            return None
        try:
            import torch
            import torch.nn.functional as F
            wav = np.asarray(waveform, dtype=np.float32).ravel()
            if wav.size == 0:
                return None
            if sample_rate != 16000:
                from app.utils.audio import resample
                wav = resample(wav, sample_rate, 16000)
            # Per-utterance layer norm, exactly like the reference recipe.
            t = torch.from_numpy(wav)
            t = F.layer_norm(t, t.shape)
            with self._lock:
                with torch.no_grad():
                    logits = self.det.forward_logits(t.unsqueeze(0))
                    probs = torch.softmax(logits, dim=1)[0]
            return float(probs[0].item())  # index 0 = fake
        except Exception as e:
            print(f"[AntiDeepfake] inference failed: {e}")
            return None


_instance = None
def get_model():
    global _instance
    if _instance is None:
        _instance = _Model()
    return _instance


def predict(waveform: np.ndarray, sample_rate: int):
    return get_model().predict(waveform, sample_rate)
