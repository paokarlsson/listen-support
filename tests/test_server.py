import numpy as np
from starlette.testclient import TestClient

from app.config import Config, AudioConfig
from app.main import create_app
from app.transcriber import Transcriber, clean_text


class FakeTranscriber(Transcriber):
    name = "fake"

    def __init__(self):
        self.calls = 0

    def transcribe(self, audio, prompt=""):
        self.calls += 1
        return "vi måste prata om budgeten för nya kontoret"


def tone(seconds, amp=8000):
    t = np.arange(int(seconds * 16000)) / 16000
    return (amp * np.sin(2 * np.pi * 220 * t)).astype("<i2").tobytes()


def make_client():
    cfg = Config(audio=AudioConfig(chunk_seconds=1, max_chunk_seconds=1.5))
    fake = FakeTranscriber()
    return TestClient(create_app(cfg, transcriber=fake)), fake


def test_ws_flow_reset_and_export():
    client, fake = make_client()
    with client:
        with client.websocket_connect("/ws") as ws:
            hello = ws.receive_json()
            assert hello["type"] == "hello"
            assert hello["settings"]["transcriber"] == "fake"

            ws.send_bytes(tone(1.6))
            msgs = [ws.receive_json(), ws.receive_json()]
            kinds = {m["type"] for m in msgs}
            assert kinds == {"chunk", "update"}
            update = next(m for m in msgs if m["type"] == "update")
            assert update["segment"].startswith("vi måste")
            assert update["terms"][0]["weight"] == 1.0
            assert "latency_ms" in update

            ws.send_json({"type": "settings", "half_life": 60, "top_n": 10})
            s = ws.receive_json()
            assert s["type"] == "settings"
            assert s["settings"]["half_life"] == 60 and s["settings"]["top_n"] == 10

            exp = client.get("/export").json()
            assert len(exp["segments"]) == 1
            assert exp["terms"]

            assert client.post("/reset").json() == {"ok": True}
            assert ws.receive_json()["type"] == "reset"
            assert client.get("/export").json()["segments"] == []


def test_index_served():
    client, _ = make_client()
    with client:
        r = client.get("/")
        assert r.status_code == 200 and "Talmoln" in r.text
        assert client.get("/static/pcm-worklet.js").status_code == 200


def test_clean_text_removes_hallucinations():
    assert clean_text(" Textning.nu ") == ""
    assert clean_text("[MUSIK] Hej budgeten. Tack för att ni tittade!") == "Hej budgeten. !"
    assert clean_text("  vi pratar om flytten ") == "vi pratar om flytten"
