"""Test 4: once a technique is rejected, later turns must not select it again (real LLM call)."""

from conftest import llm_available, send_message


@llm_available
def test_rejected_technique_is_not_reused(auth_client, active_session):
    session_id = active_session["id"]

    # Turn 1: the user explicitly rejects the grounding/breathing technique.
    first = send_message(auth_client, session_id, "我不喜欢呼吸练习，请换一种方式帮助我。")
    assert first.status_code == 200, first.text
    detail = auth_client.get(f"/api/sessions/{session_id}").json()
    assert "grounding" in detail["rejected_techniques"], detail["rejected_techniques"]

    # Turn 2: a tense follow-up — the model must avoid grounding this time.
    second = send_message(auth_client, session_id, "现在心跳还是很快，脑子里很乱，我该怎么办？")
    assert second.status_code == 200, second.text
    record = second.json()["strategy_record"]

    assert record["technique"] != "grounding", "a rejected technique must not be selected again"
    avoided_techniques = record["avoided_techniques"]
    assert any(item["technique"] == "grounding" for item in avoided_techniques), (
        "the strategy panel must explain what was avoided and why"
    )


@llm_available
def test_llm_channel_rejection_is_recorded(auth_client, active_session):
    # "这一步行动规划不适合我" — no regex channel hit is guaranteed for action_planning,
    # so this also exercises the LLM's user_rejected_technique channel when it fires.
    response = send_message(auth_client, active_session["id"], "换一种方式吧，我不想做计划。")
    assert response.status_code == 200, response.text
    detail = auth_client.get(f"/api/sessions/{active_session['id']}").json()
    # Either channel must have recorded the rejection by now.
    assert "action_planning" in detail["rejected_techniques"] or "reframing" in detail["rejected_techniques"], (
        detail["rejected_techniques"]
    )
