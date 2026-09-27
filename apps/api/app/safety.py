"""Layer-1 deterministic safety rules and fixed safety responses.

These are pure server-side constants. Safety judgment must NOT rely solely on
the conversational LLM prompt, so keyword matching runs before any LLM call.
"""

# Explicit self-harm / suicide wording, or requests for medication dosing /
# withdrawal plans. Any hit maps directly to the fixed safety-escalation reply.
HIGH_RISK_KEYWORDS: tuple[str, ...] = (
    "自杀",
    "自残",
    "自伤",
    "不想活",
    "轻生",
    "结束生命",
    "结束自己的生命",
    "想死",
    "去死",
    "了结自己",
    "安眠药吃多少",
    "药物剂量",
    "停药方案",
    "怎么停药",
)

# Ambiguous wording that requires a one-shot safety confirmation question.
AMBIGUOUS_RISK_KEYWORDS: tuple[str, ...] = (
    "活着没意思",
    "活着没什么意思",
    "撑不下去",
    "撑不下去了",
    "想消失",
    "消失算了",
    "不存在就好了",
    "解脱",
    "一了百了",
)


def assess_text_risk(text: str) -> str | None:
    """Return 'high' / 'ambiguous' when the deterministic keyword rules hit, else None."""
    if any(keyword in text for keyword in HIGH_RISK_KEYWORDS):
        return "high"
    if any(keyword in text for keyword in AMBIGUOUS_RISK_KEYWORDS):
        return "ambiguous"
    return None


# Fixed high-risk reply. Five required elements per the assignment:
# capability boundary (non-diagnostic), professional help encouragement,
# emergency-service guidance, no medication dosing or guarantees, gentle tone.
SAFETY_ESCALATION_REPLY = (
    "谢谢你愿意告诉我这些，我很在意你现在的安全。我是 AI 心理支持助手，不能进行诊断或治疗，"
    "也无法提供药物剂量或停药方面的建议。如果你正处于危险之中，请立即联系当地紧急服务，"
    "或联系一位你信任的人陪在身边。无论何时，你都可以拨打心理援助热线，或与专业心理咨询师、"
    "精神科医生聊一聊，他们会比我能给你的帮助更多、更专业。你不是一个人在面对这些。"
)

# Fixed ambiguous-risk confirmation: a short, direct, one-shot safety check.
SAFETY_CONFIRMATION_REPLY = (
    "听起来你现在承受着不小的压力，我想先直接确认一下：你有没有伤害自己或让一切都结束的念头？"
    "你可以放心告诉我，我需要先了解这一点，才能更好地支持你。"
)

SAFETY_DISCLAIMER = (
    "本工具为非医疗性质的辅助心理支持服务，不构成任何医学诊断、治疗建议或药物指导，"
    "也不能替代心理咨询师、精神科医生或紧急援助服务。"
)
