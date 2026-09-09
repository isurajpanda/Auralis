from fastapi import WebSocket
from typing import Dict, Set
import json
import asyncio

class ConnectionManager:
    def __init__(self):
        self.connections: Dict[str, Set[WebSocket]] = {}

    async def connect(self, session_id: str, websocket: WebSocket):
        await websocket.accept()
        if session_id not in self.connections:
            self.connections[session_id] = set()
        self.connections[session_id].add(websocket)
        print(f"[WS] Client connected to {session_id}, total {len(self.connections[session_id])}")

    def disconnect(self, session_id: str, websocket: WebSocket):
        if session_id in self.connections:
            self.connections[session_id].discard(websocket)
            if not self.connections[session_id]:
                del self.connections[session_id]
        print(f"[WS] Client disconnected from {session_id}")

    async def broadcast(self, session_id: str, message: dict):
        if session_id not in self.connections:
            return
        dead = []
        for ws in list(self.connections[session_id]):
            try:
                await ws.send_json(message)
            except Exception as e:
                print(f"[WS] Send failed: {e}")
                dead.append(ws)
        for ws in dead:
            self.disconnect(session_id, ws)

    async def send_alert(self, session_id: str, risk_level: str, message: str):
        await self.broadcast(session_id, {
            "type": "alert",
            "session_id": session_id,
            "risk_level": risk_level,
            "message": message
        })

manager = ConnectionManager()
