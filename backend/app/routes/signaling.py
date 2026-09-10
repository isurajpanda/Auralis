from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.ws.signaling import signaling_manager
import json

router = APIRouter()

@router.get("/api/presence")
async def presence():
    """Connected signaling clients for the dashboard.

    Returns [{extension, connections, in_call, in_call_with}].
    Only extensions with at least one open tab appear; the dashboard
    merges this with the known extension list to show offline ones.
    """
    return signaling_manager.presence()

@router.websocket("/ws/signal/{extension}")
async def signal_ws(websocket: WebSocket, extension: str):
    await signaling_manager.register(extension, websocket)
    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
            except:
                continue
            mtype = msg.get("type")
            target = msg.get("target")  # extension to relay to
            # Attach sender
            msg["from"] = extension
            if mtype in ("offer", "answer", "ice", "hangup", "invite"):
                if target:
                    if mtype in ("offer", "answer"):
                        sdp = (msg.get("sdp") or {})
                        print(f"[Signal] {mtype} {extension}->{target} "
                              f"sdp_len={len(sdp.get('sdp', '')) if isinstance(sdp, dict) else len(str(sdp))}")
                    elif mtype == "hangup":
                        print(f"[Signal] hangup {extension}->{target} reason={msg.get('reason')}")
                    await signaling_manager.relay(target, msg)
                if mtype == "answer":
                    # One tab answered: stand down sibling tabs of the
                    # answerer that are still ringing with the same offer.
                    await signaling_manager.notify_other_peers(
                        extension, websocket,
                        {"type": "hangup", "from": extension,
                         "reason": "answered-elsewhere"})
                # Also handle call session mapping for live detection
                if mtype == "offer" and target:
                    # create call session mapping caller->callee for detection
                    call_id = msg.get("call_id") or f"{extension}-{target}"
                    signaling_manager.calls[call_id] = {"caller": extension, "callee": target}
                    # cap the map: call_ids are unique per call, so prune
                    # oldest entries to bound memory on a busy network
                    while len(signaling_manager.calls) > 200:
                        try:
                            signaling_manager.calls.pop(next(iter(signaling_manager.calls)))
                        except StopIteration:
                            break
                    # Optionally start a risk session for this call
                    from app.sessions.session_manager import create_session
                    from app.sip.asterisk_bridge import handle_live_audio_chunk
                    # We don't auto-create here; frontend will POST /api/calls/start with mode=live
                # NOTE: hangup needs no extra handling — the full msg (incl.
                # "reason": declined/busy/ended/cancelled) was already relayed
                # above via signaling_manager.relay(target, msg).
                if mtype == "hangup" and target:
                    # free both sides so presence flips back to idle and
                    # concurrent calls by other clients aren't marked busy
                    signaling_manager.end_call_between(extension, target)
            elif mtype == "audio_chunk":
                # Live PCM chunk from browser: {type:"audio_chunk", session_id, chunk_index, pcm_b64, sample_rate}
                import base64
                sid = msg.get("session_id")
                idx = msg.get("chunk_index", 0)
                pcm_b64 = msg.get("pcm_b64", "")
                sr = msg.get("sample_rate", 16000)
                if sid and pcm_b64:
                    try:
                        pcm = base64.b64decode(pcm_b64)
                        print(f"[Signal] audio_chunk via signal-ws sid={sid[:8]} idx={idx} {len(pcm)}B sr={sr}")
                        from app.sip.asterisk_bridge import handle_live_audio_chunk
                        await handle_live_audio_chunk(sid, idx, pcm, sr)
                    except Exception as e:
                        print(f"[Signal] audio_chunk failed {e}")
                else:
                    print(f"[Signal] audio_chunk missing sid/pcm from {extension} (has_sid={bool(sid)} b64len={len(pcm_b64)})")
            elif mtype == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        signaling_manager.unregister(extension, websocket)
    except Exception as e:
        print(f"[Signal] ws error {extension}: {e}")
        signaling_manager.unregister(extension, websocket)
