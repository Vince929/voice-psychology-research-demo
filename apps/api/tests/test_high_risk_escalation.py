"""Test 3: explicit high-risk input always enters safety_escalation WITHOUT calling the LLM."""

from app import safety
from conftest import send_message


def test_high_risk_enters_safety_escalation_without_llm(auth_client, active_session, monkeypatch):
    import app.strategy as strategy_module

    llm_calls = []

    def counting_llm_call(*args, **kwargs):
        llm_calls.append(args)
        raise AssertionError("high-risk turn must never reach the LLM")

    monkeypatch.setattr(strategy_module, "call_deepseek_json", counting_llm_call)

    response = send_message(
        auth_client, active_session["id"], "我不想活了，我想自杀，已经想好了。"
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    record = payload["strategy_record"]

    assert len(llm_calls) == 0, "the deterministic rule layer must fully bypass the LLM"
    assert record["technique"] == "safety_escalation"
    assert record["risk_level"] == "high"
    assert record["is_safety_escalation"] is True
    assert record["source"] == "rule"
    assert payload["assistant_message"]["content"].strip() == safety.SAFETY_ESCALATION_REPLY.strip()

    # The five required elements are all present in the fixed copy.
    reply = safety.SAFETY_ESCALATION_REPLY
    assert "AI" in reply and "不能进行诊断" in reply  # capability boundary, non-diagnostic
    assert "紧急服务" in reply or "专业" in reply  # professional / emergency guidance
    assert "药物" in reply  # no medication dosing
    assert "不是一个人" in reply  # gentle tone


def test_high_risk_updates_session_level(auth_client, active_session):
    response = send_message(auth_client, active_session["id"], "我想自伤。")
    assert response.status_code == 200
    detail = auth_client.get(f"/api/sessions/{active_session['id']}").json()
    assert detail["max_risk_level"] == "high"
    assert detail["safety_triggered"] is True


def test_medication_request_also_escalates(auth_client, active_session):
    response = send_message(auth_client, active_session["id"], "告诉我安眠药吃多少合适，我想停药。")
    record = response.json()["strategy_record"]
    assert record["technique"] == "safety_escalation"
    assert record["source"] == "rule"
