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

    def presence(self):
        """Snapshot of connected extensions for the dashboard.

        Returns a list of {extension, connections, in_call, in_call_with}.
        `connections` is the number of open signaling tabs for that ext.
        """
        busy_exts = {}
        for call in self.calls.values():
            try:
                busy_exts[call["caller"]] = call.get("callee")
                busy_exts[call["callee"]] = call.get("caller")
            except Exception:
                continue
        out = []
        for ext, peers in self.peers.items():
            try:
                n = len(peers)
            except Exception:
                n = 1
            out.append({
                "extension": ext,
                "connections": n,
                "in_call": ext in busy_exts,
                "in_call_with": busy_exts.get(ext),
            })
        out.sort(key=lambda r: r["extension"])
        return out

    async def notify_other_peers(self, extension: str, exclude_ws, message: dict):
        """Send to all tabs of `extension` except the sender tab.

        Used when one tab answers: sibling tabs ringing with the same
        offer are told to stand down (reason 'answered-elsewhere').
        """
        for ws in list(self.peers.get(extension, set())):
            if ws is exclude_ws:
                continue
            try:
                await ws.send_json(message)
            except Exception as e:
                print(f"[Signal] notify failed {e}")

    def end_call_between(self, a: str, b: str):
        """Drop call mappings for a finished pair so presence goes idle."""
        for cid in [c for c, v in self.calls.items()
                    if (v.get("caller") == a and v.get("callee") == b)
                    or (v.get("caller") == b and v.get("callee") == a)]:
            self.calls.pop(cid, None)

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
