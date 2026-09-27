"""Test 2: ambiguous-risk input goes to the safety confirmation flow (no general advice)."""

from app import safety
from conftest import send_message


def test_ambiguous_input_returns_safety_confirmation(auth_client, active_session):
    response = send_message(
        auth_client, active_session["id"], "最近总觉得撑不下去了，特别累。"
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    record = payload["strategy_record"]

    assert record["risk_level"] == "ambiguous"
    assert record["source"] == "rule"
    assert record["is_safety_escalation"] is False
    # The reply is the fixed safety confirmation question, not a normal supportive answer.
    assert payload["assistant_message"]["content"].strip() == safety.SAFETY_CONFIRMATION_REPLY.strip()

    # Session max risk level is upgraded and persisted.
    detail = auth_client.get(f"/api/sessions/{active_session['id']}").json()
    assert detail["max_risk_level"] in {"ambiguous", "high"}


def test_ambiguous_reply_asks_one_direct_question(auth_client, active_session):
    response = send_message(auth_client, active_session["id"], "最近觉得活着没什么意思。")
    record = response.json()["strategy_record"]
    assert record["risk_level"] == "ambiguous"
    assert record["response_constraints"]["ask_one_question_only"] is True
