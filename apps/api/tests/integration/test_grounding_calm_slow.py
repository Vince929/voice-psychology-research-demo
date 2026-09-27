"""Acceptance demo item 2: obvious nervousness selects grounding with a short
reply and the actual calm_slow TTS parameters (deterministic, no real LLM)."""

import app.strategy
from app.schemas import StrategyLLMOutput

from conftest import send_message


def _fake_output(**overrides) -> dict:
    output = {
        "anxiety_level": "high",
        "risk_level": "normal",
        "observed_signals": ["用户表达心跳加快、思绪混乱"],
        "support_goal": "即时稳定",
        "technique": "grounding",
        "technique_reason": "用户呈现明显紧张躯体信号，先做即时稳定",
        "response_constraints": {"max_sentences": 2, "ask_one_question_only": True},
        "voice_profile": "warm_normal",  # LLM suggestion must NOT win over the server rule
        "reply_text": "先和我一起做一次慢呼吸。吸气四秒，再缓缓吐出来。现在试试看好吗？",
        "user_rejected_technique": None,
    }
    output.update(overrides)
    return output


def _install_llm(monkeypatch, raw: dict):
    def fake_llm_call(_system_prompt, _user_content, _followup=None):
        return raw, "fake-request-id"

    monkeypatch.setattr(app.strategy, "call_deepseek_json", fake_llm_call)


def test_nervous_input_selects_grounding_and_calm_slow(auth_client, active_session, monkeypatch):
    _install_llm(monkeypatch, _fake_output())
    response = send_message(
        auth_client, active_session["id"], "我现在心跳特别快，脑子里一团乱，喘不上气。"
    )
    assert response.status_code == 200, response.text
    record = response.json()["strategy_record"]

    # Grounding technique for obvious nervousness, normal risk path.
    assert record["technique"] == "grounding"
    assert record["risk_level"] == "normal"
    assert record["source"] == "llm"
    assert record["anxiety_level"] == "high"

    # The server-side rule (high anxiety -> calm_slow) overrides the LLM's suggestion.
    assert record["voice_profile"] == "calm_slow"

    # The actual TTS parameters handed to the client.
    assert record["tts_params"] == {
        "voice_profile": "calm_slow",
        "rate": 0.7,
        "pitch": 0.9,
        "inter_sentence_pause_ms": 800,
        "override_applied": False,
    }


def test_grounding_reply_is_truncated_to_short(auth_client, active_session, monkeypatch):
    """The response_constraints safety net actually truncates long replies."""
    _install_llm(
        monkeypatch,
        _fake_output(
            reply_text="我们先慢下来做一次呼吸。跟着我的节奏吸气。再缓缓地吐气。做完这一轮告诉我感觉如何。"
        ),
    )
    response = send_message(
        auth_client, active_session["id"], "我很紧张，手一直在抖，坐不住。"
    )
    assert response.status_code == 200, response.text
    content = response.json()["assistant_message"]["content"]
    sentences = [part for part in content.replace("。", "。\n").split("\n") if part.strip()]
    assert len(sentences) == 2, f"expected the 4-sentence reply truncated to 2, got: {content!r}"


def test_fake_outputs_match_the_pydantic_schema():
    """Guard: the fake outputs above stay valid against the real schema."""
    StrategyLLMOutput.model_validate(_fake_output())
