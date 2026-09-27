"""Technique-rejection detection (regex channel) and session-level memory."""

import re

from .models import ChatSession

# (technique enum, patterns that reject it)
_REJECTION_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("grounding", re.compile(r"(不喜欢|别再做|不要再|不想做|换一种|换个方式|别让我)[^。！？,，]*?(呼吸|稳定练习|放松练习|着陆|grounding)|((呼吸|稳定练习|放松练习|着陆|grounding)[^。！？,，]{0,12}(不喜欢|别再做|不要再|不想做|没用|帮不上))")),
    ("reframing", re.compile(r"(不喜欢|别再做|不要再|不想做|换一种|换个方式|别让我)[^。！？,，]*?(换个角度|重新想|认知重构|reframing)|((换个角度|重新想|认知重构|reframing)[^。！？,，]{0,12}(不喜欢|别再做|不要再|不想做|没用|帮不上))")),
    ("action_planning", re.compile(r"(不喜欢|别再做|不要再|不想做|换一种|换个方式|别让我)[^。！？,，]*?(计划|行动|步骤|做计划)|((计划|行动|步骤)[^。！？,，]{0,12}(不喜欢|别再做|不要再|不想做|没用|帮不上))")),
)


def detect_rejected_technique(text: str) -> str | None:
    """Return a technique enum when the user's wording explicitly rejects it."""
    for technique, pattern in _REJECTION_PATTERNS:
        if pattern.search(text):
            return technique
    return None


def remember_rejection(session: ChatSession, technique: str) -> bool:
    """Append a technique to the session's rejection list. Returns True when new."""
    rejected = list(session.rejected_techniques or [])
    if technique in rejected:
        return False
    rejected.append(technique)
    session.rejected_techniques = rejected
    return True


def build_avoided_techniques(session: ChatSession, chosen_technique: str) -> list[dict]:
    """Explain which techniques were avoided this turn and why (for the strategy panel)."""
    avoided: list[dict] = []
    for technique in session.rejected_techniques or []:
        if technique != chosen_technique:
            avoided.append({"technique": technique, "reason": "用户在本次会话中明确拒绝过该方法"})
    return avoided
