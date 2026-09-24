from datetime import datetime

from sqlalchemy import DateTime, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class CollectionRecord(Base):
    __tablename__ = "collection_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    subject_id: Mapped[str] = mapped_column(String(128), index=True)
    age_group: Mapped[str | None] = mapped_column(String(32), nullable=True)
    gender: Mapped[str | None] = mapped_column(String(32), nullable=True)
    audio_path: Mapped[str] = mapped_column(String(512))
    phq9_answers: Mapped[dict] = mapped_column(JSON)
    mbti_answers: Mapped[dict] = mapped_column(JSON)
    analysis_result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
