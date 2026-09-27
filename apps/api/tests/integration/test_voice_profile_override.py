"""Bonus feature: the user can edit the Agent's voice style, but the override
NEVER beats safety requirements or a high-anxiety state (priority stays
safety > current state > user preference > default, enforced server-side)."""

from conftest import llm_available, send_message


def test_preferences_patch_persists_override(auth_client, active_session):
    session_id = active_session["id"]

    response = auth_client.patch(
        f"/api/sessions/{session_id}/preferences", json={"voice_profile_override": "calm_slow"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["voice_profile_override"] == "calm_slow"

    detail = auth_client.get(f"/api/sessions/{session_id}").json()
    assert detail["voice_profile_override"] == "calm_slow"

    # null clears the override back to auto.
    response = auth_client.patch(
        f"/api/sessions/{session_id}/preferences", json={"voice_profile_override": None}
    )
    assert response.status_code == 200, response.text
    assert response.json()["voice_profile_override"] is None


@llm_available
def test_override_rejected_on_ended_session(auth_client, active_session):
    session_id = active_session["id"]
    reply = send_message(auth_client, session_id, "你好，我想聊聊最近的压力。")
    assert reply.status_code == 200, reply.text
    ended = auth_client.post(f"/api/sessions/{session_id}/end")
    assert ended.status_code == 200, ended.text

    response = auth_client.patch(
        f"/api/sessions/{session_id}/preferences", json={"voice_profile_override": "calm_slow"}
    )
    assert response.status_code == 409


def test_high_risk_turn_ignores_user_override(auth_client, active_session):
    """Rule-based (no LLM): a high-risk turn must keep calm_slow no matter
    what the user picked, and the record must prove the override was skipped."""
    session_id = active_session["id"]
    patched = auth_client.patch(
        f"/api/sessions/{session_id}/preferences", json={"voice_profile_override": "concise_direct"}
    )
    assert patched.status_code == 200, patched.text

    response = send_message(auth_client, session_id, "我想自杀")
    assert response.status_code == 200, response.text
    record = response.json()["strategy_record"]
    assert record["voice_profile"] == "calm_slow"
    assert record["tts_params"]["rate"] == 0.7
    assert record["tts_params"]["override_applied"] is False


@llm_available
def test_override_applied_on_normal_turn(auth_client, active_session):
    """Real LLM turn with a calm input: the user's choice wins over the derived
    profile, and tts_params records override_applied=true."""
    session_id = active_session["id"]
    patched = auth_client.patch(
        f"/api/sessions/{session_id}/preferences", json={"voice_profile_override": "calm_slow"}
    )
    assert patched.status_code == 200, patched.text

    response = send_message(
        auth_client, session_id, "今天整体还不错，就是工作上的事偶尔让我有点小担心，想随便聊聊。"
    )
    assert response.status_code == 200, response.text
    record = response.json()["strategy_record"]
    assert record["voice_profile"] == "calm_slow", record
    assert record["tts_params"]["override_applied"] is True, record["tts_params"]
