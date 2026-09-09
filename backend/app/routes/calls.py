from fastapi import APIRouter, HTTPException
import os

from app.schemas import StartCallRequest, StartCallResponse
from app.sessions.session_manager import create_session, end_session, list_calls, get_call

router = APIRouter()

@router.post("/calls/start", response_model=StartCallResponse)
async def start_call(req: StartCallRequest):
    session_id = create_session(req.mode, req.replay_sample)
    if req.mode == "replay":
        # resolve sample path
        sample = req.replay_sample or "bonafide"
        wav_path = os.path.join(os.path.dirname(__file__), f"../../data/sample-calls/{sample}.wav")
        wav_path = os.path.abspath(wav_path)
        # start background replay
        from app.replay.replay_engine import start_replay_background
        start_replay_background(session_id, wav_path)
    elif req.mode == "live":
        from app.sip.asterisk_bridge import start_asterisk_tap
        # optional live; still create session
        import asyncio
        asyncio.create_task(start_asterisk_tap(session_id, {}))
    return {"session_id": session_id}

@router.post("/calls/{session_id}/end")
async def end_call(session_id: str):
    call = get_call(session_id)
    if not call:
        raise HTTPException(status_code=404, detail="Session not found")
    result = end_session(session_id)
    from app.replay.replay_engine import end_session_cleanup
    end_session_cleanup(session_id)
    return {"session_id": session_id, **result}

@router.get("/calls")
async def list_calls_endpoint():
    return list_calls()

@router.get("/calls/{session_id}")
async def get_call_endpoint(session_id: str):
    call = get_call(session_id)
    if not call:
        raise HTTPException(status_code=404, detail="Session not found")
    return call
