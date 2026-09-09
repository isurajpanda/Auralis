from pydantic import BaseModel
from typing import Optional, Literal

class StartCallRequest(BaseModel):
    mode: Literal["live", "replay"] = "replay"
    replay_sample: Optional[Literal["bonafide", "cloned"]] = "bonafide"

class StartCallResponse(BaseModel):
    session_id: str

class CallInfo(BaseModel):
    session_id: str
    mode: str
    started_at: str
    ended_at: Optional[str] = None
    final_risk_level: Optional[str] = None
    final_risk_score: Optional[float] = None
    chunk_count: int = 0

class ScoreEntry(BaseModel):
    chunk_index: int
    model_scores: dict
    fused_risk_score: float
    risk_level: str
    timestamp: str

class CallDetail(BaseModel):
    session_id: str
    mode: str
    started_at: str
    ended_at: Optional[str] = None
    final_risk_level: Optional[str] = None
    final_risk_score: Optional[float] = None
    scores: list[ScoreEntry]
