import sqlite3
import json
import uuid
import datetime
import threading
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "../../voice_guard.db")
DB_PATH = os.path.abspath(DB_PATH)

_lock = threading.Lock()

def _now_iso():
    return datetime.datetime.utcnow().isoformat() + "Z"

def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS calls (
            session_id TEXT PRIMARY KEY,
            mode TEXT,
            started_at TEXT,
            ended_at TEXT,
            final_risk_level TEXT,
            final_risk_score REAL,
            replay_sample TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS scores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            chunk_index INTEGER,
            model_scores TEXT,
            fused_risk_score REAL,
            risk_level TEXT,
            timestamp TEXT,
            FOREIGN KEY(session_id) REFERENCES calls(session_id)
        )
    """)
    conn.commit()
    conn.close()

def create_session(mode: str, replay_sample: str | None = None) -> str:
    init_db()
    sid = str(uuid.uuid4())
    now = _now_iso()
    with _lock:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute("INSERT INTO calls (session_id, mode, started_at, replay_sample) VALUES (?,?,?,?)",
                    (sid, mode, now, replay_sample))
        conn.commit()
        conn.close()
    return sid

def end_session(session_id: str):
    now = _now_iso()
    with _lock:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        # compute final score
        cur.execute("SELECT fused_risk_score, risk_level FROM scores WHERE session_id=? ORDER BY chunk_index DESC LIMIT 1", (session_id,))
        row = cur.fetchone()
        final_score = row[0] if row else None
        final_level = row[1] if row else None
        cur.execute("UPDATE calls SET ended_at=?, final_risk_score=?, final_risk_level=? WHERE session_id=?",
                    (now, final_score, final_level, session_id))
        conn.commit()
        conn.close()
    return {"ended_at": now, "final_risk_score": final_score, "final_risk_level": final_level}

def add_score(session_id: str, chunk_index: int, model_scores: dict, fused_risk_score: float, risk_level: str):
    ts = _now_iso()
    # feature-only logging: if enabled, could strip raw audio but we don't store audio anyway
    from app.config import FEATURE_ONLY_LOGGING
    # we only store scores, never raw audio, so flag is implicitly respected
    with _lock:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute("INSERT INTO scores (session_id, chunk_index, model_scores, fused_risk_score, risk_level, timestamp) VALUES (?,?,?,?,?,?)",
                    (session_id, chunk_index, json.dumps(model_scores), fused_risk_score, risk_level, ts))
        conn.commit()
        conn.close()
    return ts

def list_calls():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM calls ORDER BY started_at DESC")
    rows = cur.fetchall()
    result = []
    for r in rows:
        cur2 = conn.cursor()
        cur2.execute("SELECT COUNT(*) FROM scores WHERE session_id=?", (r["session_id"],))
        count = cur2.fetchone()[0]
        result.append({
            "session_id": r["session_id"],
            "mode": r["mode"],
            "started_at": r["started_at"],
            "ended_at": r["ended_at"],
            "final_risk_level": r["final_risk_level"],
            "final_risk_score": r["final_risk_score"],
            "chunk_count": count
        })
    conn.close()
    return result

def get_call(session_id: str):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM calls WHERE session_id=?", (session_id,))
    call = cur.fetchone()
    if not call:
        conn.close()
        return None
    cur.execute("SELECT chunk_index, model_scores, fused_risk_score, risk_level, timestamp FROM scores WHERE session_id=? ORDER BY chunk_index ASC", (session_id,))
    scores = []
    for row in cur.fetchall():
        scores.append({
            "chunk_index": row["chunk_index"],
            "model_scores": json.loads(row["model_scores"]),
            "fused_risk_score": row["fused_risk_score"],
            "risk_level": row["risk_level"],
            "timestamp": row["timestamp"]
        })
    conn.close()
    return {
        "session_id": call["session_id"],
        "mode": call["mode"],
        "started_at": call["started_at"],
        "ended_at": call["ended_at"],
        "final_risk_level": call["final_risk_level"],
        "final_risk_score": call["final_risk_score"],
        "scores": scores
    }

def in_memory_active_sessions():
    # helper for replay engine to check existence
    pass
