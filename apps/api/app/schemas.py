from typing import Literal

from pydantic import BaseModel, Field, field_validator

AnxietyLevel = Literal["low", "moderate", "high", "uncertain"]
RiskLevel = Literal["normal", "ambiguous", "high"]
Technique = Literal[
    "validation", "clarification", "grounding", "reframing", "action_planning", "safety_escalation"
]
SupportTechnique = Literal[
    "validation", "clarification", "grounding", "reframing", "action_planning"
]
VoiceProfile = Literal["calm_slow", "warm_normal", "concise_direct"]


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class SessionCreate(BaseModel):
    concern: str = Field(min_length=1, max_length=255)
    expression_preference: Literal["gentle", "concise"]
    voice_reply_enabled: bool = True
    # User-edited voice style (bonus). None = auto (server-derived each turn);
    # never applied on safety escalations or high-anxiety/risk turns.
    voice_profile_override: VoiceProfile | None = None


class SessionPreferenceUpdate(BaseModel):
    """PATCH /api/sessions/{id}/preferences body. voice_profile_override=null
    clears the override back to auto."""

    voice_profile_override: VoiceProfile | None = None


class MessageTextRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class ReplyFeedbackUpdate(BaseModel):
    """User rating for an assistant reply. `unhelpful` blocks its technique
    for the remainder of this session; safety escalation is never blocked."""

    feedback: Literal["helpful", "unhelpful"]


class ResponseConstraints(BaseModel):
    max_sentences: int = Field(default=3, ge=1, le=5)
    ask_one_question_only: bool = True


class StrategyLLMOutput(BaseModel):
    """Validated schema of the per-turn DeepSeek response. Any missing field,
    wrong type or illegal enum value raised here must NOT enter the normal flow."""

    anxiety_level: AnxietyLevel
    risk_level: RiskLevel
    observed_signals: list[str] = Field(min_length=1)
    support_goal: str = Field(min_length=1, max_length=512)
    technique: Technique
    technique_reason: str = Field(min_length=1, max_length=512)
    response_constraints: ResponseConstraints = ResponseConstraints()
    voice_profile: VoiceProfile
    reply_text: str = Field(min_length=1, max_length=2000)
    user_rejected_technique: SupportTechnique | None = None

    @field_validator("observed_signals")
    @classmethod
    def clean_signals(cls, value: list[str]) -> list[str]:
        cleaned = [signal.strip() for signal in value if signal and signal.strip()]
        if not cleaned:
            raise ValueError("observed_signals must contain at least one non-empty string")
        return cleaned


class SummaryOutput(BaseModel):
    main_concern: str = Field(min_length=1, max_length=512)
    # The prompt explicitly allows an empty array ("无则空数组") for sessions
    # where the user never expressed a feeling -- the schema must agree.
    key_feelings: list[str] = Field(default_factory=list)
    techniques_used: list[str] = Field(default_factory=list)
    rejected_methods: list[str] = Field(default_factory=list)
    agreed_next_step: str = Field(min_length=1, max_length=512)
    risk_level: RiskLevel
    safety_escalation_triggered: bool = False
    disclaimer: str = Field(min_length=1, max_length=512)
