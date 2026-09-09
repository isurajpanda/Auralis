import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.replay import replay_engine as re


def test_append_window_accumulates_and_caps():
    a = np.ones(32000, dtype=np.float32)
    buf = re.append_window(None, a, 64000)
    assert len(buf) == 32000
    buf = re.append_window(buf, a * 2, 64000)
    assert len(buf) == 64000
    assert float(buf[0]) == 1.0 and float(buf[-1]) == 2.0
    buf = re.append_window(buf, a * 3, 64000)
    assert len(buf) == 64000
    assert float(buf[0]) == 2.0 and float(buf[-1]) == 3.0


def test_smooth_score_rolling_mean():
    hist = []
    assert re.smooth_score(hist, 60.0, 3) == 60.0
    assert re.smooth_score(hist, 30.0, 3) == 45.0
    assert re.smooth_score(hist, 30.0, 3) == 40.0
    # window slides: [30, 30, 0] after next value
    assert re.smooth_score(hist, 0.0, 3) == 20.0
    assert len(hist) == 3


def test_sustained_medium_needs_consecutive():
    lv = []
    assert re.sustained_medium(lv, "low", 2) is False
    assert re.sustained_medium(lv, "medium", 2) is False  # only 1 so far
    assert re.sustained_medium(lv, "medium", 2) is True  # 2 consecutive
    assert re.sustained_medium(lv, "low", 2) is False  # streak broken
    assert re.sustained_medium(lv, "high", 2) is False
    assert re.sustained_medium(lv, "high", 2) is True


def test_end_session_cleanup():
    sid = "test-session-cleanup"
    re._buffers[sid] = np.ones(100, dtype=np.float32)
    re._fused_hist[sid] = [1.0]
    re._level_hist[sid] = ["low"]
    re.end_session_cleanup(sid)
    assert sid not in re._buffers
    assert sid not in re._fused_hist
    assert sid not in re._level_hist


def test_window_for_session_respects_env_window():
    from app.config import REAL_WINDOW_SECONDS, SAMPLE_RATE
    sid = "test-session-window"
    re.end_session_cleanup(sid)
    chunk = np.ones(SAMPLE_RATE * 2, dtype=np.float32)  # 2s
    for _ in range(5):
        w = re._window_for_session(sid, chunk)
    assert len(w) == SAMPLE_RATE * REAL_WINDOW_SECONDS
    re.end_session_cleanup(sid)
