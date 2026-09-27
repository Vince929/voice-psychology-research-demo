"""Acceptance demo item 7: end a session, re-login, and still see the history
and the summary (deterministic, no real LLM)."""

import app.main
import app.strategy
from app.summary import generate_summary

from conftest import send_message


FAKE_TURN = {
    "anxiety_level": "moderate",
    "risk_level": "normal",
    "observed_signals": ["用户表达工作压力"],
    "support_goal": "接纳情绪并澄清压力来源",
    "technique": "validation",
    "technique_reason": "用户表达压力感受",
    "response_constraints": {"max_sentences": 3, "ask_one_question_only": True},
    "voice_profile": "warm_normal",
    "reply_text": "听起来最近工作压力确实不小，这种紧绷的感受很真实。你愿意说说最近是哪件事最让你放心不下吗？",
    "user_rejected_technique": None,
}

FAKE_SUMMARY = {
    "main_concern": "工作压力",
    "key_feelings": ["紧张", "担心做不好"],
    "techniques_used": ["validation"],
    "rejected_methods": [],
    "agreed_next_step": "本次会话未确认下一步行动",
    "risk_level": "normal",
    "safety_escalation_triggered": False,
    "disclaimer": "本总结不构成医学诊断或治疗建议。",
}


def _install_fakes(monkeypatch):
    def fake_llm_call(_system_prompt, _user_content, _followup=None):
        return FAKE_TURN, "fake-request-id"

    def fake_summary_llm(_system_prompt, _user_content, _followup=None):
        return FAKE_SUMMARY, "fake-summary-id"

    monkeypatch.setattr(app.strategy, "call_deepseek_json", fake_llm_call)
    # generate_summary's default llm_call is bound at def time, so wrap it.
    monkeypatch.setattr(
        app.main, "generate_summary", lambda session: generate_summary(session, llm_call=fake_summary_llm)
    )


def test_end_session_then_relogin_sees_history_and_summary(auth_client, active_session, monkeypatch, client):
    _install_fakes(monkeypatch)
    session_id = active_session["id"]

    # Build a real conversation first.
    first = send_message(auth_client, session_id, "最近工作压力很大，总担心自己做不好。")
    assert first.status_code == 200, first.text
    second = send_message(auth_client, session_id, "主要是下周的汇报，一想到就紧张。")
    assert second.status_code == 200, second.text

    # End the session: a structured summary must come back.
    ended = auth_client.post(f"/api/sessions/{session_id}/end")
    assert ended.status_code == 200, ended.text
    summary = ended.json()["summary"]
    for field in (
        "main_concern", "key_feelings", "techniques_used", "rejected_methods",
        "agreed_next_step", "risk_level", "safety_escalation_triggered", "disclaimer",
    ):
        assert field in summary
    assert summary == FAKE_SUMMARY

    # Second end is idempotent.
    again = auth_client.post(f"/api/sessions/{session_id}/end")
    assert again.status_code == 200
    assert again.json()["idempotent"] is True

    # Ended sessions no longer accept new messages.
    blocked = send_message(auth_client, session_id, "还想再聊一句。")
    assert blocked.status_code == 409, blocked.text

    # "Re-login": a brand-new client + fresh token for the same account.
    login = client.post("/api/auth/login", json={"username": "demo1", "password": "Passw0rd!"})
    assert login.status_code == 200
    relogin = type(client)(app.main.app)
    relogin.headers.update({"Authorization": f"Bearer {login.json()['token']}"})

    detail = relogin.get(f"/api/sessions/{session_id}").json()
    assert detail["status"] == "ended"
    assert detail["summary"] == FAKE_SUMMARY
    assert len(detail["messages"]) == 4  # two turns -> user + assistant each
    assert all(message["content"] for message in detail["messages"])

    listings = relogin.get("/api/sessions").json()
    mine = [item for item in listings if item["id"] == session_id]
    assert mine and mine[0]["status"] == "ended" and mine[0]["summary"] is not None


def test_ended_session_summary_still_hidden_from_other_users(auth_client, active_session, monkeypatch, client, demo2_token):
    """The summary/history visibility is still ownership-scoped after ending."""
    _install_fakes(monkeypatch)
    session_id = active_session["id"]
    assert send_message(auth_client, session_id, "有点睡不着。").status_code == 200
    assert auth_client.post(f"/api/sessions/{session_id}/end").status_code == 200

    other = type(client)(app.main.app)
    other.headers.update({"Authorization": f"Bearer {demo2_token}"})
    assert other.get(f"/api/sessions/{session_id}").status_code == 404
    assert other.post(f"/api/sessions/{session_id}/end").status_code == 404
