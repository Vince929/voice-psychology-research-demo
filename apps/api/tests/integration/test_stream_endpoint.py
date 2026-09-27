"""Test 6: the SSE streaming endpoint emits deltas and ends with a validated result (real LLM call)."""

import json

from conftest import llm_available


def _read_stream_events(response) -> list[dict]:
    events: list[dict] = []
    for line in response.iter_lines():
        if isinstance(line, bytes):
            line = line.decode("utf-8")
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if payload:
            events.append(json.loads(payload))
    return events


@llm_available
def test_stream_endpoint_finishes_with_result_event(auth_client, active_session):
    with auth_client.stream(
        "POST",
        f"/api/sessions/{active_session['id']}/messages/stream",
        json={"text": "最近工作压力有点大，晚上翻来覆去睡不着。"},
    ) as response:
        assert response.status_code == 200, response.text
        assert response.headers["content-type"].startswith("text/event-stream")
        events = _read_stream_events(response)

    assert events, "stream must produce at least one event"
    assert events[-1]["type"] == "result", f"stream must end with result, got {events[-1]}"
    deltas = [event["text"] for event in events if event["type"] == "delta"]
    # Deltas are display-only and may be empty when the reply is replaced by a
    # fixed safety text, but a normal anxiety input should stream fragments.
    streamed = "".join(deltas)
    assert streamed, "normal input should stream reply fragments"

    result = events[-1]["result"]
    assistant_message = result["assistant_message"]
    record = result["strategy_record"]
    assert record["risk_level"] == "normal"
    assert assistant_message["content"].strip()
    # The persisted reply is authoritative; it may be constraint-truncated
    # relative to the streamed fragments.
    assert assistant_message["content"] in streamed or streamed.startswith(
        assistant_message["content"][:16]
    ) or len(assistant_message["content"]) <= len(streamed), (
        "persisted reply should relate to the streamed text"
    )

    # The turn is durably persisted, same as the non-streaming endpoint.
    detail = auth_client.get(f"/api/sessions/{active_session['id']}").json()
    assert any(message["id"] == assistant_message["id"] for message in detail["messages"])


@llm_available
def test_stream_endpoint_rule_path_has_no_deltas(auth_client, active_session):
    """High-risk keyword input short-circuits to the fixed safety reply: one result event, no deltas."""
    with auth_client.stream(
        "POST",
        f"/api/sessions/{active_session['id']}/messages/stream",
        json={"text": "我想自杀，撑不下去了。"},
    ) as response:
        assert response.status_code == 200, response.text
        events = _read_stream_events(response)

    assert [event["type"] for event in events] == ["result"]
    record = events[0]["result"]["strategy_record"]
    assert record["technique"] == "safety_escalation"
    assert record["source"] == "rule"
