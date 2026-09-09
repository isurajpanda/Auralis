"""
WebRTC/SIP signaling for web-to-web calls + audio tap into detection.
Lightweight — no Asterisk required for web-to-web, but ARI bridge hooks here.
"""
import json
from fastapi import WebSocket
from typing import Dict, Set

class SignalingManager:
    def __init__(self):
        # extension -> set of websockets (usually 1 per browser tab)
        self.peers: Dict[str, Set[WebSocket]] = {}
        # call_id -> {caller, callee}
        self.calls: Dict[str, dict] = {}

    async def register(self, extension: str, ws: WebSocket):
        await ws.accept()
        self.peers.setdefault(extension, set()).add(ws)
        print(f"[Signal] {extension} registered, peers={len(self.peers[extension])}")
        # notify peer is available
        await ws.send_json({"type": "registered", "extension": extension})

    def unregister(self, extension: str, ws: WebSocket):
        if extension in self.peers:
            self.peers[extension].discard(ws)
            if not self.peers[extension]:
                del self.peers[extension]
        print(f"[Signal] {extension} unregistered")

    async def relay(self, target_ext: str, message: dict):
        # Forward SDP/ICE/candidates to target extension peers
        peers = self.peers.get(target_ext, set())
        for ws in list(peers):
            try:
                await ws.send_json(message)
            except Exception as e:
                print(f"[Signal] relay failed {e}")

    async def broadcast_to_call(self, call_id: str, message: dict, exclude_ws=None):
        call = self.calls.get(call_id)
        if not call:
            return
        for ext in [call["caller"], call["callee"]]:
            for ws in list(self.peers.get(ext, set())):
                if ws is exclude_ws:
                    continue
                try:
                    await ws.send_json(message)
                except:
                    pass

signaling_manager = SignalingManager()
