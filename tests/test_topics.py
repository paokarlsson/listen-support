import asyncio
import json

import httpx
import pytest

from app.config import TopicConfig
from app.topics import TOOL_NAME, TopicLayer


def tool_response(topics, usage=(1200, 80)):
    return {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "model": "claude-haiku-5-5",
        "stop_reason": "tool_use",
        "content": [{"type": "tool_use", "id": "toolu_1", "name": TOOL_NAME, "input": {"topics": topics}}],
        "usage": {"input_tokens": usage[0], "output_tokens": usage[1]},
    }


def layer_with(handler, **cfg):
    clock = {"t": 1000.0}
    layer = TopicLayer(TopicConfig(**cfg), api_key="test-key",
                       transport=httpx.MockTransport(handler), clock=lambda: clock["t"])
    return layer, clock


def run(coro):
    return asyncio.run(coro)


def test_request_shape_and_parsing():
    seen = {}

    def handler(request: httpx.Request):
        seen["headers"] = request.headers
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=tool_response([
            {"label": "Kontorsflytten", "weight": 0.9, "keywords": ["flytten", "nya kontoret"]},
            {"label": "Budget", "weight": 0.6, "keywords": ["budgeten"]},
        ]))

    layer, _ = layer_with(handler)
    assert run(layer.refresh("vi måste prata om budgeten för nya kontoret")) is True

    body = seen["body"]
    assert seen["headers"]["x-api-key"] == "test-key"
    assert seen["headers"]["anthropic-version"]
    assert body["model"] == "claude-haiku-5-5"
    assert body["tools"][0]["strict"] is True
    assert body["tool_choice"] == {"type": "tool", "name": TOOL_NAME}
    assert "temperature" not in body
    assert "budgeten" in body["messages"][0]["content"]

    topics = layer.current()
    assert [t.label for t in topics] == ["Kontorsflytten", "Budget"]
    info = layer.info()
    assert info["status"] == "ok" and info["last_update_s"] == 0
    assert info["usage"] == {"calls": 1, "failed": 0, "input_tokens": 1200, "output_tokens": 80}


def test_previous_topics_are_sent_back():
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json=tool_response([{"label": "Budget", "weight": 0.8, "keywords": ["budgeten"]}]))

    layer, clock = layer_with(handler)
    run(layer.refresh("budgeten"))
    clock["t"] += 60
    run(layer.refresh("budgeten igen"))
    assert "(inga ännu)" in bodies[0]["messages"][0]["content"]
    assert '"label": "Budget"' in bodies[1]["messages"][0]["content"]


@pytest.mark.parametrize("handler, status", [
    (lambda r: (_ for _ in ()).throw(httpx.ConnectError("nej", request=r)), "offline"),
    (lambda r: (_ for _ in ()).throw(httpx.ReadTimeout("slut", request=r)), "offline"),
    (lambda r: httpx.Response(429, json={"type": "error", "error": {"type": "rate_limit_error", "message": "lugn"}}), "error"),
    (lambda r: httpx.Response(529, json={"type": "error", "error": {"type": "overloaded_error", "message": "full"}}), "error"),
    (lambda r: httpx.Response(200, json={"content": [{"type": "text", "text": "hej"}], "stop_reason": "end_turn", "usage": {}}), "error"),
    (lambda r: httpx.Response(200, json={"content": [], "stop_reason": "refusal", "usage": {}}), "error"),
])
def test_errors_keep_old_topics_and_never_raise(handler, status):
    layer, clock = layer_with(handler)
    layer.apply([{"label": "Budget", "weight": 1.0, "keywords": ["budgeten"]}], clock["t"])
    clock["t"] += 120
    assert run(layer.refresh("text")) is False
    assert layer.info()["status"] == status
    assert layer.usage["failed"] == 1
    kept = layer.current()
    assert [t.label for t in kept] == ["Budget"]
    assert kept[0].score == pytest.approx(0.5)  # avklingar med halveringstiden


def test_should_call_respects_interval_words_key_and_toggle():
    layer, clock = layer_with(lambda r: httpx.Response(200, json=tool_response([])),
                              interval_seconds=45, min_new_words=40)
    assert layer.should_call(40)
    assert not layer.should_call(39)
    run(layer.refresh("x"))
    assert not layer.should_call(100)
    clock["t"] += 45
    assert layer.should_call(100)
    layer.set_enabled(False)
    assert not layer.should_call(100)
    assert layer.info()["status"] == "off" and layer.info()["reason"] == "disabled"

    nokey = TopicLayer(TopicConfig(), api_key="")
    assert not nokey.should_call(1000)
    assert nokey.info()["reason"] == "no_key"
    assert run(nokey.refresh("x")) is False


def test_weights_blend_and_renamed_topics_are_matched():
    layer, clock = layer_with(lambda r: None, half_life_seconds=60)
    layer.apply([{"label": "Kontorsflytten", "weight": 1.0, "keywords": ["flytten", "nya kontoret", "lokal"]}], 0)
    # Nästa svar döper om ämnet men med samma nyckelord → samma ämne, gamla namnet behålls.
    layer.apply([{"label": "Flytt till nytt kontor", "weight": 0.2, "keywords": ["flytten", "nya kontoret", "lokal"]}], 60)
    topics = layer.current(60)
    assert [t.label for t in topics] == ["Kontorsflytten"]
    assert topics[0].score == pytest.approx(0.5 * 0.5 + 0.5 * 0.2)


def test_disabling_clears_topics():
    layer, _ = layer_with(lambda r: None)
    layer.apply([{"label": "Budget", "weight": 1.0, "keywords": []}], 1000)
    layer.set_enabled(False)
    assert layer.current() == []


def test_cloud_terms_topics_largest_and_keywords_grouped():
    layer, _ = layer_with(lambda r: None, keyword_factor=0.5)
    layer.apply([
        {"label": "Kontorsflytten", "weight": 1.0, "keywords": ["flytten", "nya kontoret"]},
        {"label": "Budget", "weight": 0.6, "keywords": ["budgeten", "flytten"]},
    ], 1000)
    rows = layer.cloud_terms()
    assert rows[0] == {"text": "Kontorsflytten", "weight": 1.0, "kind": "topic", "topic": "Kontorsflytten"}
    assert rows[1]["text"] == "Budget" and rows[1]["weight"] == pytest.approx(0.6)
    by_text = {r["text"]: r for r in rows}
    # "flytten" finns i båda ämnena: hamnar hos det starkaste
    assert by_text["flytten"] == {"text": "flytten", "weight": 0.5, "kind": "keyword", "topic": "Kontorsflytten"}
    assert by_text["budgeten"]["topic"] == "Budget"
    assert by_text["budgeten"]["weight"] == pytest.approx(0.3)
    assert len(rows) == 5


def test_cloud_terms_respects_max_words_and_show_keywords():
    layer, _ = layer_with(lambda r: None, show_keywords=False)
    layer.apply([{"label": "Budget", "weight": 0.4, "keywords": ["budgeten"]},
                 {"label": "Semestern", "weight": 0.8, "keywords": ["gotland"]}], 1000)
    assert [r["text"] for r in layer.cloud_terms()] == ["Semestern", "Budget"]
    assert layer.cloud_terms()[0]["weight"] == 1.0
    assert len(layer.cloud_terms(max_words=1)) == 1
    layer.set_enabled(False)
    assert layer.cloud_terms() == []


def test_set_half_life_keeps_current_scores():
    layer, clock = layer_with(lambda r: None, half_life_seconds=100)
    layer.apply([{"label": "Budget", "weight": 1.0, "keywords": []}], 1000)
    clock["t"] = 1100
    layer.set_half_life(10)
    assert layer.current()[0].score == pytest.approx(0.5)
    clock["t"] = 1110
    assert layer.current()[0].score == pytest.approx(0.25)
