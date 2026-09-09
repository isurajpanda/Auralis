"""Keep the default suite fast/offline: the arena models (1.2GB ONNX,
1.7GB torch) must not auto-download during tests. Heavy scoring is covered
by guarded tests in test_arena_models.py (ENABLE_HEAVY_MODEL_TESTS=1)."""
import os

os.environ.setdefault("W2V2_AASIST_ENABLED", "false")
os.environ.setdefault("DF_ARENA_ENABLED", "false")
