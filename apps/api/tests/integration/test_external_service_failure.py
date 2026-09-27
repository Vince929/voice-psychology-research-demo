"""Extra hardening tests: when an external service is unavailable the API must
surface an explicit 502 error and must NOT persist a fabricated assistant
reply (never disguise a failure as success)."""

import app.analysis_services
import app.main
from app.analysis_services import ExternalServiceError

from conftest import send_message


def _message_count(client, session_id: int) -> int:
    detail = client.get(f"/api/sessions/{session_id}").json()
    return len(detail["messages"])


def test_llm_unavailable_returns_502_without_fake_reply(auth_client, active_session, monkeypatch):
    session_id = active_session["id"]
    before = _message_count(auth_client, session_id)

    # Simulate "LLM not configured / down" without any network access.
    monkeypatch.setattr(app.analysis_services, "DEEPSEEK_API_KEY", "")

    response = send_message(auth_client, session_id, "最近工作压力有点大，想找人聊聊。")
    assert response.status_code == 502, response.text
    body = response.json()
    assert body["stage"] == "llm"

    # The failed turn must not be persisted as a fake assistant reply.
    assert _message_count(auth_client, session_id) == before
    detail = auth_client.get(f"/api/sessions/{session_id}").json()
    assert all(message["role"] != "assistant" for message in detail["messages"])


def test_asr_unavailable_returns_502_without_persisting(auth_client, active_session, monkeypatch):
    session_id = active_session["id"]
    before = _message_count(auth_client, session_id)

    def _asr_down(*_args, **_kwargs):
        raise ExternalServiceError(
            "transcription", "语音转写服务暂时不可用，请稍后重试。", True
        )

    monkeypatch.setattr(app.main, "transcribe_m4a", _asr_down)

    response = auth_client.post(
        f"/api/sessions/{session_id}/messages",
        files={"audio": ("voice-message.m4a", b"\x00\x01\x02fake-audio", "audio/mp4")},
    )
    assert response.status_code == 502, response.text
    assert response.json()["stage"] == "transcription"

    # No user message either: the whole failed turn is rolled back.
    assert _message_count(auth_client, session_id) == before


def test_safety_paths_work_even_when_llm_is_down(auth_client, active_session, monkeypatch):
    """High-risk inputs must still reach the fixed safety escalation even
    while the LLM is unavailable (safety never depends on the LLM)."""
    session_id = active_session["id"]
    monkeypatch.setattr(app.analysis_services, "DEEPSEEK_API_KEY", "")

    response = send_message(auth_client, session_id, "我想自杀")
    assert response.status_code == 200, response.text
    record = response.json()["strategy_record"]
    assert record["technique"] == "safety_escalation"
    assert record["source"] == "rule"
