"""Pure unit tests for deterministic safety, strategy-supporting, and audio logic.

These tests do not start FastAPI, connect to MySQL, call external APIs, or read
project .env credentials.
"""

from array import array

import pytest

pytestmark = pytest.mark.unit

from app.analysis_services import _ReplyTextExtractor, _estimate_pitch_hz, extract_asr_features
from app.rejection import build_avoided_techniques, detect_rejected_technique, remember_rejection
from app.safety import assess_text_risk
from app.strategy import _enforce_reply_constraints
from app.tts_profiles import resolve_turn_voice_profile


class _Session:
    def __init__(self, rejected_techniques=None) -> None:
        self.rejected_techniques = rejected_techniques


class _Constraints:
    def __init__(self, max_sentences: int, ask_one_question_only: bool) -> None:
        self.max_sentences = max_sentences
        self.ask_one_question_only = ask_one_question_only


class _StrategyOutput:
    def __init__(self, reply_text: str, max_sentences: int, ask_one_question_only: bool) -> None:
        self.reply_text = reply_text
        self.response_constraints = _Constraints(max_sentences, ask_one_question_only)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("我想自杀", "high"),
        ("安眠药吃多少合适", "high"),
        ("我真的撑不下去了", "ambiguous"),
        ("今天工作压力很大", None),
    ],
)
def test_assess_text_risk_uses_high_risk_priority(text, expected):
    assert assess_text_risk(text) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("我不喜欢呼吸练习，请换一种方式。", "grounding"),
        ("不要再让我做计划了。", "action_planning"),
        ("换个角度想对我没用。", "reframing"),
        ("我今天不想说话。", None),
    ],
)
def test_detect_rejected_technique(text, expected):
    assert detect_rejected_technique(text) == expected


def test_rejection_memory_deduplicates_and_explains_avoided_techniques():
    session = _Session(["grounding"])

    assert remember_rejection(session, "grounding") is False
    assert remember_rejection(session, "reframing") is True
    assert session.rejected_techniques == ["grounding", "reframing"]
    assert build_avoided_techniques(session, "reframing") == [
        {"technique": "grounding", "reason": "用户在本次会话中明确拒绝过该方法"}
    ]


@pytest.mark.parametrize(
    ("anxiety_level", "risk_level", "preference", "override", "expected", "applied"),
    [
        ("low", "normal", "gentle", "concise_direct", "concise_direct", True),
        ("low", "high", "gentle", "concise_direct", "calm_slow", False),
        ("low", "ambiguous", "gentle", "warm_normal", "calm_slow", False),
        ("high", "normal", "concise", "concise_direct", "calm_slow", False),
        ("moderate", "normal", "gentle", None, "warm_normal", False),
    ],
)
def test_voice_profile_priority(anxiety_level, risk_level, preference, override, expected, applied):
    assert resolve_turn_voice_profile(anxiety_level, risk_level, preference, override) == (expected, applied)


def test_reply_constraint_truncates_sentences():
    output = _StrategyOutput("第一句。第二句。第三句。", max_sentences=2, ask_one_question_only=False)

    assert _enforce_reply_constraints(output) == "第一句。第二句。"


def test_reply_constraint_keeps_only_one_question():
    output = _StrategyOutput("第一句？第二句？第三句。", max_sentences=3, ask_one_question_only=True)

    assert _enforce_reply_constraints(output) == "第一句？第二句。第三句"


def test_reply_text_extractor_handles_chunk_boundaries_and_json_escapes():
    extractor = _ReplyTextExtractor()

    visible = "".join(
        extractor.feed(chunk)
        for chunk in ('{"reply_', 'text": "你好\\n', '世界\\u0021", "risk_level": "normal"}')
    )

    assert visible == "你好\n世界!"


def test_extract_asr_features_aggregates_only_numeric_sentence_metrics():
    result = extract_asr_features(
        "你好，最近有点紧张。",
        {
            "audio_duration": 1800,
            "flash_result": [
                {
                    "sentence_list": [
                        {"text": "你好", "start_time": 0, "end_time": 500, "speech_speed": 3.2, "emotional_energy": 0.4},
                        {"text": "最近有点紧张", "start_time": 600, "end_time": 1600, "speech_speed": 4.0, "emotional_energy": "unknown"},
                    ]
                }
            ],
        },
    )

    assert result == {
        "transcript": "你好，最近有点紧张。",
        "audio_duration_ms": 1800,
        "sentence_count": 2,
        "speech_speed_summary": {"count": 2, "min": 3.2, "max": 4.0, "average": 3.6},
        "emotional_energy_summary": {"count": 1, "min": 0.4, "max": 0.4, "average": 0.4},
    }


def test_estimate_pitch_returns_frequency_for_a_voiced_periodic_frame():
    samples = array("h", [12000 if index % 80 < 40 else -12000 for index in range(1600)])

    pitch = _estimate_pitch_hz(samples, 16000)

    assert pitch is not None
    assert 180 <= pitch <= 220


def test_estimate_pitch_returns_none_for_silence():
    assert _estimate_pitch_hz(array("h", [0] * 1600), 16000) is None
