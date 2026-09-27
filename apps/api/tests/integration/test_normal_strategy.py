"""Test 1: a normal anxiety input selects a normal support strategy (real LLM call)."""

from conftest import llm_available, send_message


@llm_available
def test_normal_anxiety_selects_support_strategy(auth_client, active_session):
    response = send_message(
        auth_client,
        active_session["id"],
        "最近工作压力很大，总担心自己做不好，晚上也睡不好。",
    )
    assert response.status_code == 200, response.text
    record = response.json()["strategy_record"]

    assert record["technique"] in {"validation", "clarification", "reframing", "action_planning"}
    assert record["risk_level"] == "normal"
    assert record["source"] == "llm"
    assert isinstance(record["observed_signals"], list) and record["observed_signals"]
    assert all(isinstance(signal, str) and signal.strip() for signal in record["observed_signals"])
    assistant_message = response.json()["assistant_message"]
    assert assistant_message["content"].strip()


@llm_available
def test_schema_record_is_persisted_and_readable(auth_client, active_session):
    send_message(auth_client, active_session["id"], "下周要做工作汇报，有点紧张。")
    detail = auth_client.get(f"/api/sessions/{active_session['id']}").json()
    assert detail["messages"], "messages must be persisted"
    assert detail["strategy_records"], "strategy records must be persisted"
    record = detail["strategy_records"][-1]
    for field in (
        "anxiety_level", "risk_level", "observed_signals", "support_goal",
        "technique", "technique_reason", "response_constraints", "voice_profile", "tts_params",
    ):
        assert field in record
    assert "rate" in record["tts_params"] and "pitch" in record["tts_params"]
