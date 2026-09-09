import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.fusion import fuse_scores


def test_w2v2_pad_fixed_truncates():
    from app.models.w2v2_aasist import pad_fixed, WINDOW_SAMPLES
    wav = np.random.randn(96000).astype(np.float32)
    out = pad_fixed(wav)
    assert out.shape == (WINDOW_SAMPLES,)
    assert np.allclose(out, wav[:WINDOW_SAMPLES])


def test_w2v2_pad_fixed_tile_repeats():
    from app.models.w2v2_aasist import pad_fixed, WINDOW_SAMPLES
    wav = np.ones(1000, dtype=np.float32)
    out = pad_fixed(wav)
    assert out.shape == (WINDOW_SAMPLES,)
    assert np.allclose(out, 1.0)


def test_w2v2_pad_fixed_empty():
    from app.models.w2v2_aasist import pad_fixed, WINDOW_SAMPLES
    out = pad_fixed(np.array([], dtype=np.float32))
    assert out.shape == (WINDOW_SAMPLES,)
    assert np.allclose(out, 0.0)


def test_disabled_models_return_none():
    """Disabled arena models stay out of the fusion (no download attempted)."""
    os.environ["W2V2_AASIST_ENABLED"] = "false"
    os.environ["DF_ARENA_ENABLED"] = "false"
    from app.models import w2v2_aasist, df_arena
    w2v2_aasist._instance = None
    df_arena._instance = None
    wav = np.random.randn(32000).astype(np.float32)
    assert w2v2_aasist.get_model().predict(wav, 16000) is None
    assert df_arena.get_model().predict(wav, 16000) is None


def test_fusion_with_all_six_keys():
    b = {'aasist': 0.2, 'rawnet2': 0.25, 'xlsr': 0.2,
         'antideepfake': 0.0, 'w2v2_aasist': 0.05, 'df_arena': 0.1}
    s = {'aasist': 0.8, 'rawnet2': 0.85, 'xlsr': 0.8,
         'antideepfake': 0.999, 'w2v2_aasist': 0.95, 'df_arena': 0.9}
    fused_b, _ = fuse_scores(b)
    fused_s, lvl_s = fuse_scores(s)
    print(f"Six-model fused bonafide {fused_b:.1f} vs cloned {fused_s:.1f} {lvl_s}")
    assert fused_s > fused_b
    assert lvl_s == 'high'


def test_fusion_renormalizes_without_arena_models():
    """When arena models are absent the old blend is preserved."""
    b = {'aasist': 0.2, 'rawnet2': 0.25, 'xlsr': 0.2, 'antideepfake': 0.0}
    s = {'aasist': 0.8, 'rawnet2': 0.85, 'xlsr': 0.8, 'antideepfake': 0.999}
    fused_b, _ = fuse_scores(b)
    fused_s, lvl_s = fuse_scores(s)
    assert fused_s > fused_b
    assert lvl_s == 'high'


HEAVY = os.getenv("ENABLE_HEAVY_MODEL_TESTS", "0") == "1"


@pytest.mark.skipif(not HEAVY, reason="needs 1GB+ downloads; set ENABLE_HEAVY_MODEL_TESTS=1")
def test_w2v2_aasist_loads_and_scores():
    """Integration contract: the real W2V2-AASIST ONNX loads and returns
    deterministic P(fake) in [0,1].

    NOTE: separation (cloned > bonafide) is NOT asserted on the repo's toy
    files — measured 2026-09-09, this Arena model disagrees with them
    (toy harmonic 'cloned' scores ~0.0, some genuine 2s slices score ~0.99;
    the fence stays correct because fusion outvotes it: genuine stays low,
    cloned stays high). Separation must be re-validated on real TTS/VC
    audio; the model's published numbers are utterance-level Arena EERs
    (0.22% ASVspoof19_LA, 11.22% InTheWild), not 2s-slice guarantees.
    """
    os.environ["W2V2_AASIST_ENABLED"] = "true"
    import soundfile as sf
    from app.models import w2v2_aasist
    w2v2_aasist._instance = None
    d = os.path.join(os.path.dirname(__file__), '../data/sample-calls')
    wav_b, sr_b = sf.read(os.path.join(d, 'bonafide.wav'), dtype='float32')
    wav_s, sr_s = sf.read(os.path.join(d, 'cloned.wav'), dtype='float32')
    score_b = w2v2_aasist.predict(np.asarray(wav_b), sr_b)
    score_b2 = w2v2_aasist.predict(np.asarray(wav_b), sr_b)
    score_s = w2v2_aasist.predict(np.asarray(wav_s), sr_s)
    assert score_b is not None and score_s is not None, "model should be loaded"
    assert 0.0 <= score_b <= 1.0 and 0.0 <= score_s <= 1.0
    assert score_b == score_b2, "inference must be deterministic"
    print(f"W2V2-AASIST bonafide {score_b:.4f} vs cloned {score_s:.4f}")


@pytest.mark.skipif(not HEAVY, reason="needs 1GB+ downloads; set ENABLE_HEAVY_MODEL_TESTS=1")
def test_df_arena_graceful_when_upstream_incomplete():
    """The DF Arena repo currently lacks its custom-code files, so loading
    must fail fast with a clear reason and predict() must return None
    (never raise, never half-download weights into the fusion)."""
    os.environ["DF_ARENA_ENABLED"] = "true"
    import soundfile as sf
    from app.models import df_arena
    df_arena._instance = None
    d = os.path.join(os.path.dirname(__file__), '../data/sample-calls')
    wav_b, sr_b = sf.read(os.path.join(d, 'bonafide.wav'), dtype='float32')
    score_b = df_arena.predict(np.asarray(wav_b), sr_b)
    inst = df_arena.get_model()
    if inst.pipe is None:
        print(f"DF-Arena unavailable (expected): {inst.unavailable_reason}")
        assert score_b is None
    else:
        # Upstream fixed the repo: assert the integration contract.
        wav_s, sr_s = sf.read(os.path.join(d, 'cloned.wav'), dtype='float32')
        score_s = df_arena.predict(np.asarray(wav_s), sr_s)
        assert score_b is not None and score_s is not None
        assert 0.0 <= score_b <= 1.0 and 0.0 <= score_s <= 1.0
        print(f"DF-Arena bonafide {score_b:.4f} vs cloned {score_s:.4f}")
