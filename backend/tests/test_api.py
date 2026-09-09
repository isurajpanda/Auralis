import os, sys, asyncio
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_health():
    r = client.get('/health')
    assert r.status_code == 200
    assert r.json()['status'] == 'ok'
    assert len(r.json()['models_loaded']) >= 3

def test_start_replay_and_list():
    r = client.post('/api/calls/start', json={'mode':'replay','replay_sample':'bonafide'})
    assert r.status_code == 200
    sid = r.json()['session_id']
    assert sid
    r2 = client.get('/api/calls')
    assert r2.status_code == 200
    assert any(c['session_id']==sid for c in r2.json())
    # end
    r3 = client.post(f'/api/calls/{sid}/end')
    assert r3.status_code == 200
