import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import soundfile as sf
from app.models.aasist import predict as aasist_predict
from app.models.rawnet2 import predict as rawnet2_predict
from app.models.xlsr import predict as xlsr_predict
from app.fusion import fuse_scores

SAMPLE_DIR = os.path.join(os.path.dirname(__file__), '../data/sample-calls')

def test_aasist_spoof_higher():
    wav_b, sr_b = sf.read(os.path.join(SAMPLE_DIR, 'bonafide.wav'), dtype='float32')
    wav_s, sr_s = sf.read(os.path.join(SAMPLE_DIR, 'cloned.wav'), dtype='float32')
    score_b = aasist_predict(wav_b[:32000], sr_b)
    score_s = aasist_predict(wav_s[:32000], sr_s)
    print(f"AASIST bonafide {score_b:.4f} vs cloned {score_s:.4f}")
    assert score_s > score_b, "AASIST cloned should score higher"

def test_rawnet2_spoof_higher():
    wav_b, sr_b = sf.read(os.path.join(SAMPLE_DIR, 'bonafide.wav'), dtype='float32')
    wav_s, sr_s = sf.read(os.path.join(SAMPLE_DIR, 'cloned.wav'), dtype='float32')
    score_b = rawnet2_predict(wav_b[:32000], sr_b)
    score_s = rawnet2_predict(wav_s[:32000], sr_s)
    print(f"RawNet2 bonafide {score_b:.4f} vs cloned {score_s:.4f}")
    assert score_s > score_b

def test_xlsr_spoof_higher():
    wav_b, sr_b = sf.read(os.path.join(SAMPLE_DIR, 'bonafide.wav'), dtype='float32')
    wav_s, sr_s = sf.read(os.path.join(SAMPLE_DIR, 'cloned.wav'), dtype='float32')
    score_b = xlsr_predict(wav_b[:32000], sr_b)
    score_s = xlsr_predict(wav_s[:32000], sr_s)
    print(f"XLSR bonafide {score_b:.4f} vs cloned {score_s:.4f}")
    assert score_s > score_b

def test_fusion_spoof_higher():
    wav_b, sr_b = sf.read(os.path.join(SAMPLE_DIR, 'bonafide.wav'), dtype='float32')
    wav_s, sr_s = sf.read(os.path.join(SAMPLE_DIR, 'cloned.wav'), dtype='float32')
    b = {'aasist': aasist_predict(wav_b[:32000], sr_b), 'rawnet2': rawnet2_predict(wav_b[:32000], sr_b), 'xlsr': xlsr_predict(wav_b[:32000], sr_b)}
    s = {'aasist': aasist_predict(wav_s[:32000], sr_s), 'rawnet2': rawnet2_predict(wav_s[:32000], sr_s), 'xlsr': xlsr_predict(wav_s[:32000], sr_s)}
    fused_b, lvl_b = fuse_scores(b)
    fused_s, lvl_s = fuse_scores(s)
    print(f"Fused bonafide {fused_b:.1f} {lvl_b} vs cloned {fused_s:.1f} {lvl_s}")
    assert fused_s > fused_b
    assert fused_s > 70 or lvl_s == 'high', "Cloned should trigger high risk"
