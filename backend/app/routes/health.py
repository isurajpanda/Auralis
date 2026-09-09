from fastapi import APIRouter

router = APIRouter()

@router.get("/health")
async def health():
    # Check which models are loaded
    models_loaded = []
    try:
        from app.models.aasist import get_model as get_aasist
        m = get_aasist()
        if m.loaded:
            models_loaded.append("aasist")
    except Exception:
        pass
    try:
        from app.models.rawnet2 import get_model as get_rawnet
        m = get_rawnet()
        if m.loaded:
            models_loaded.append("rawnet2")
    except Exception:
        pass
    try:
        from app.models.xlsr import get_model as get_xlsr
        m = get_xlsr()
        if m.loaded:
            models_loaded.append("xlsr")
    except Exception:
        pass
    # Real detectors: report only if already loaded (never trigger a
    # multi-GB download from a /health probe; lifespan loads them).
    try:
        from app.models import antideepfake as real_mod
        inst = getattr(real_mod, "_instance", None)
        if inst is not None and inst.det is not None:
            models_loaded.append("antideepfake")
    except Exception:
        pass
    try:
        from app.models import w2v2_aasist as w2v2_mod
        inst = getattr(w2v2_mod, "_instance", None)
        if inst is not None and inst.session is not None:
            models_loaded.append("w2v2_aasist")
    except Exception:
        pass
    try:
        from app.models import df_arena as arena_mod
        inst = getattr(arena_mod, "_instance", None)
        if inst is not None and inst.pipe is not None:
            models_loaded.append("df_arena")
    except Exception:
        pass
    return {"status": "ok", "models_loaded": models_loaded}
