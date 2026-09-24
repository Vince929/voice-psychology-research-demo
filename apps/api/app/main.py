import json
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from .cos_storage import audio_cos_storage
from .database import get_db
from .models import CollectionRecord

app = FastAPI(
    title="Voice Psychology Research Demo API",
    description="Local-only research collection demo. It is not a medical diagnostic service.",
    version="0.1.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost", "http://127.0.0.1"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health_check() -> dict[str, bool]:
    return {"ok": True}


@app.post("/api/submit_record")
def submit_record(
    audio: UploadFile = File(...),
    subject: str = Form(...),
    phq9: str = Form(...),
    mbti: str = Form(...),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    try:
        subject_data = json.loads(subject)
        phq9_data = json.loads(phq9)
        mbti_data = json.loads(mbti)
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=422, detail="subject, phq9 and mbti must be valid JSON") from error

    subject_id = subject_data.get("subject_id")
    if not subject_id:
        raise HTTPException(status_code=422, detail="subject_id is required")

    suffix = Path(audio.filename or "recording.aac").suffix.lower() or ".aac"
    audio_key = audio_cos_storage.upload(audio.file, suffix)

    # The default mode intentionally only stores research data. Any analysis is a future
    # developer-only integration and must never be treated as medical advice.
    record = CollectionRecord(
        subject_id=subject_id,
        age_group=subject_data.get("age_group"),
        gender=subject_data.get("gender"),
        audio_path=audio_key,
        phq9_answers=phq9_data,
        mbti_answers=mbti_data,
        analysis_result=None,
    )
    db.add(record)
    try:
        db.commit()
    except Exception:
        db.rollback()
        audio_cos_storage.delete(audio_key)
        raise
    db.refresh(record)
    return {"record_id": record.id}


@app.get("/api/records")
def list_records(db: Session = Depends(get_db)) -> list[dict]:
    records = db.query(CollectionRecord).order_by(CollectionRecord.created_at.desc()).all()
    return [
        {
            "id": record.id,
            "subject_id": record.subject_id,
            "phq9_total": sum(record.phq9_answers.values()),
            "created_at": record.created_at,
        }
        for record in records
    ]


@app.get("/api/record/{record_id}")
def get_record(record_id: int, db: Session = Depends(get_db)) -> dict:
    record = db.get(CollectionRecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Record not found")
    return {
        "id": record.id,
        "subject_id": record.subject_id,
        "age_group": record.age_group,
        "gender": record.gender,
        "phq9_answers": record.phq9_answers,
        "mbti_answers": record.mbti_answers,
        "analysis_result": record.analysis_result,
        "created_at": record.created_at,
    }


@app.get("/api/audio/{record_id}")
def get_audio(record_id: int, db: Session = Depends(get_db)) -> StreamingResponse:
    record = db.get(CollectionRecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Audio not found")
    return StreamingResponse(audio_cos_storage.stream(record.audio_path), media_type="audio/aac")


@app.delete("/api/record/{record_id}")
def delete_record(record_id: int, db: Session = Depends(get_db)) -> dict[str, bool]:
    record = db.get(CollectionRecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Record not found")
    audio_cos_storage.delete(record.audio_path)
    db.delete(record)
    db.commit()
    return {"deleted": True}


@app.delete("/api/subject/{subject_id}")
def delete_subject_records(subject_id: str, db: Session = Depends(get_db)) -> dict[str, int]:
    records = db.query(CollectionRecord).filter(CollectionRecord.subject_id == subject_id).all()
    for record in records:
        audio_cos_storage.delete(record.audio_path)
        db.delete(record)
    db.commit()
    return {"deleted_count": len(records)}
