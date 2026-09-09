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
    return {"status": "ok", "models_loaded": models_loaded}
