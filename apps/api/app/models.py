from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    sessions: Mapped[list["ChatSession"]] = relationship(back_populates="user")


class ChatSession(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    concern: Mapped[str] = mapped_column(String(255))
    expression_preference: Mapped[str] = mapped_column(String(16))  # 'gentle' | 'concise'
    voice_reply_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # User-edited voice profile (bonus feature). NULL = server-derived automatically;
    # ignored whenever safety requirements or a high/ambiguous risk demand calm_slow.
    voice_profile_override: Mapped[str | None] = mapped_column(String(32), nullable=True)
    rejected_techniques: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)  # 'active' | 'ended'
    max_risk_level: Mapped[str] = mapped_column(String(16), default="normal")
    safety_triggered: Mapped[bool] = mapped_column(Boolean, default=False)
    summary: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    user: Mapped[User] = relationship(back_populates="sessions")
    messages: Mapped[list["Message"]] = relationship(
        back_populates="session", cascade="all, delete-orphan", order_by="Message.id"
    )
    strategy_records: Mapped[list["StrategyRecord"]] = relationship(
        back_populates="session", cascade="all, delete-orphan", order_by="StrategyRecord.id"
    )


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16))  # 'user' | 'assistant'
    content: Mapped[str] = mapped_column(Text)
    audio_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    asr_features: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    session: Mapped[ChatSession] = relationship(back_populates="messages")
    strategy_record: Mapped["StrategyRecord | None"] = relationship(
        back_populates="message", cascade="all, delete-orphan", uselist=False
    )


class StrategyRecord(Base):
    __tablename__ = "strategy_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"), index=True)
    message_id: Mapped[int] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"))
    anxiety_level: Mapped[str] = mapped_column(String(16))  # low | moderate | high | uncertain
    risk_level: Mapped[str] = mapped_column(String(16))  # normal | ambiguous | high
    observed_signals: Mapped[list] = mapped_column(JSON)
    support_goal: Mapped[str] = mapped_column(String(512))
    technique: Mapped[str] = mapped_column(String(32))
    technique_reason: Mapped[str] = mapped_column(String(512))
    response_constraints: Mapped[dict] = mapped_column(JSON)
    voice_profile: Mapped[str] = mapped_column(String(32))  # calm_slow | warm_normal | concise_direct
    tts_params: Mapped[dict] = mapped_column(JSON)
    avoided_techniques: Mapped[list] = mapped_column(JSON)
    is_safety_escalation: Mapped[bool] = mapped_column(Boolean, default=False)
    source: Mapped[str] = mapped_column(String(8))  # 'rule' | 'llm'
    # Explicit user rating of the generated reply; NULL means not rated yet.
    feedback: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    session: Mapped[ChatSession] = relationship(back_populates="strategy_records")
    message: Mapped[Message] = relationship(back_populates="strategy_record")


class AuditLog(Base):
    """Append-only audit trail. Stores actions + structured metadata only;
    message content and transcripts are deliberately never written here."""

    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(32), index=True)
    session_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
