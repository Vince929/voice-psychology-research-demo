"""Deterministic voice-profile selection and real TTS parameters.

The voice profile is derived on the server with the priority
safety > current anxiety state > user expression preference > default,
independent from the LLM's suggested profile, so the rule stays testable.
"""

from .schemas import AnxietyLevel

VOICE_PROFILES: dict[str, dict] = {
    "calm_slow": {
        "rate": 0.7,
        "pitch": 0.9,
        "inter_sentence_pause_ms": 800,
        "description": "明显紧张或安全轮：较慢语速、稳定柔和语气、更长停顿",
    },
    "warm_normal": {
        "rate": 1.0,
        "pitch": 1.0,
        "inter_sentence_pause_ms": 400,
        "description": "一般焦虑：温和、正常语速",
    },
    "concise_direct": {
        "rate": 1.15,
        "pitch": 1.0,
        "inter_sentence_pause_ms": 200,
        "description": "状态相对稳定且偏好直接表达：减少套话、略快语速",
    },
}


def resolve_voice_profile(
    anxiety_level: AnxietyLevel,
    expression_preference: str,
    is_safety_escalation: bool,
) -> str:
    """Deterministically pick one of the three voice profiles."""
    if is_safety_escalation:
        return "calm_slow"
    if anxiety_level == "high":
        return "calm_slow"
    if anxiety_level in ("moderate", "uncertain"):
        return "concise_direct" if expression_preference == "concise" else "warm_normal"
    # low
    return "concise_direct" if expression_preference == "concise" else "warm_normal"


def resolve_turn_voice_profile(
    anxiety_level: AnxietyLevel,
    risk_level: str,
    expression_preference: str,
    voice_profile_override: str | None,
) -> tuple[str, bool]:
    """Resolve the voice profile for one turn, honouring the user's editable
    override (bonus feature) while keeping the fixed priority
    safety > current state > user preference > default.

    The override NEVER applies when the turn is a safety escalation or the
    risk/anxiety state demands calm_slow. Returns (profile, override_applied).
    """
    if risk_level in ("high", "ambiguous") or anxiety_level == "high":
        # Safety requirements and the current state always win over the override.
        return "calm_slow", False
    if voice_profile_override:
        return voice_profile_override, True
    return resolve_voice_profile(anxiety_level, expression_preference, False), False


def tts_params_for(voice_profile: str, override_applied: bool = False) -> dict:
    """The actual parameters handed to react-native-tts on the client."""
    profile = VOICE_PROFILES[voice_profile]
    return {
        "voice_profile": voice_profile,
        "rate": profile["rate"],
        "pitch": profile["pitch"],
        "inter_sentence_pause_ms": profile["inter_sentence_pause_ms"],
        "override_applied": override_applied,
    }
