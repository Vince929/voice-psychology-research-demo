import json
import shutil
from pathlib import Path
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .config import ENABLE_DEEPSEEK_ANALYSIS, UPLOAD_AUDIO_DIR
from .database import Base, engine, get_db
from .models import CollectionRecord

Base.metadata.create_all(bind=engine)
UPLOAD_AUDIO_DIR.mkdir(parents=True, exist_ok=True)

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
    return {"ok": True, "deepseek_analysis_enabled": ENABLE_DEEPSEEK_ANALYSIS}


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

    suffix = Path(audio.filename or "recording.aac").suffix or ".aac"
    destination = UPLOAD_AUDIO_DIR / f"{uuid4()}{suffix}"
    with destination.open("wb") as output:
        shutil.copyfileobj(audio.file, output)

    # The default mode intentionally only stores research data. Any analysis is a future
    # developer-only integration and must never be treated as medical advice.
    record = CollectionRecord(
        subject_id=subject_id,
        age_group=subject_data.get("age_group"),
        gender=subject_data.get("gender"),
        audio_path=str(destination),
        phq9_answers=phq9_data,
        mbti_answers=mbti_data,
        analysis_result=None,
    )
    db.add(record)
    db.commit()
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
def get_audio(record_id: int, db: Session = Depends(get_db)) -> FileResponse:
    record = db.get(CollectionRecord, record_id)
    if record is None or not Path(record.audio_path).is_file():
        raise HTTPException(status_code=404, detail="Audio not found")
    return FileResponse(record.audio_path, media_type="audio/aac")


@app.delete("/api/record/{record_id}")
def delete_record(record_id: int, db: Session = Depends(get_db)) -> dict[str, bool]:
    record = db.get(CollectionRecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Record not found")
    Path(record.audio_path).unlink(missing_ok=True)
    db.delete(record)
    db.commit()
    return {"deleted": True}


@app.delete("/api/subject/{subject_id}")
def delete_subject_records(subject_id: str, db: Session = Depends(get_db)) -> dict[str, int]:
    records = db.query(CollectionRecord).filter(CollectionRecord.subject_id == subject_id).all()
    for record in records:
        Path(record.audio_path).unlink(missing_ok=True)
        db.delete(record)
    db.commit()
    return {"deleted_count": len(records)}
