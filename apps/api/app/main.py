import json
from datetime import datetime
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from .cos_storage import audio_cos_storage
from .database import get_db
from .models import AnalysisTask, CollectionRecord

app = FastAPI(
    title="Voice Expression Insight Demo API",
    description="Voice collection and experimental expression insight demo. It is not a medical diagnostic service.",
    version="0.2.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost", "http://127.0.0.1"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


TASK_ACTIVE_STATUSES = {"pending", "transcribing", "analyzing"}


def task_summary(task: AnalysisTask | None) -> dict | None:
    if task is None:
        return None
    return {
        "id": task.id,
        "status": task.status,
        "attempt_count": task.attempt_count,
        "max_attempts": task.max_attempts,
        "failed_stage": task.failed_stage,
        "error_message": task.error_message,
        "created_at": task.created_at,
        "started_at": task.started_at,
        "finished_at": task.finished_at,
    }


def record_summary(record: CollectionRecord) -> dict:
    return {
        "id": record.id,
        "subject_id": record.subject_id,
        "audio_filename": record.audio_filename,
        "created_at": record.created_at,
        "task": task_summary(record.analysis_task),
    }


def load_record(db: Session, record_id: int) -> CollectionRecord:
    record = (
        db.query(CollectionRecord)
        .options(joinedload(CollectionRecord.analysis_task))
        .filter(CollectionRecord.id == record_id)
        .one_or_none()
    )
    if record is None:
        raise HTTPException(status_code=404, detail="Record not found")
    return record


@app.get("/api/health")
def health_check() -> dict[str, bool]:
    return {"ok": True}


@app.post("/api/records")
def create_record(
    audio: UploadFile = File(...),
    subject: str = Form(...),
    idempotency_key: str = Form(...),
    db: Session = Depends(get_db),
) -> dict:
    try:
        subject_data = json.loads(subject)
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=422, detail="subject must be valid JSON") from error

    subject_id = str(subject_data.get("subject_id", "")).strip()
    if not subject_id:
        raise HTTPException(status_code=422, detail="subject_id is required")
    if not idempotency_key.strip():
        raise HTTPException(status_code=422, detail="idempotency_key is required")

    existing = (
        db.query(CollectionRecord)
        .options(joinedload(CollectionRecord.analysis_task))
        .filter(CollectionRecord.idempotency_key == idempotency_key)
        .one_or_none()
    )
    if existing is not None:
        return {"record_id": existing.id, "task": task_summary(existing.analysis_task), "idempotent": True}

    suffix = Path(audio.filename or "voice-sample.m4a").suffix.lower() or ".m4a"
    if suffix not in {".m4a", ".aac"}:
        raise HTTPException(status_code=422, detail="Only m4a or aac recordings are supported")

    audio_key = audio_cos_storage.upload(audio.file, suffix, audio.content_type or "audio/mp4")
    record = CollectionRecord(
        subject_id=subject_id,
        age_group=subject_data.get("age_group"),
        gender=subject_data.get("gender"),
        language=subject_data.get("language", "普通话"),
        recording_environment=subject_data.get("recording_environment"),
        audio_path=audio_key,
        audio_filename=audio.filename or f"voice-sample{suffix}",
        audio_content_type=audio.content_type or "audio/mp4",
        idempotency_key=idempotency_key,
    )
    task = AnalysisTask(record=record, max_attempts=3)
    db.add_all((record, task))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        audio_cos_storage.delete(audio_key)
        existing = (
            db.query(CollectionRecord)
            .options(joinedload(CollectionRecord.analysis_task))
            .filter(CollectionRecord.idempotency_key == idempotency_key)
            .one()
        )
        return {"record_id": existing.id, "task": task_summary(existing.analysis_task), "idempotent": True}
    except Exception:
        db.rollback()
        audio_cos_storage.delete(audio_key)
        raise
    db.refresh(record)
    db.refresh(task)
    return {"record_id": record.id, "task": task_summary(task), "idempotent": False}


@app.get("/api/records")
def list_records(db: Session = Depends(get_db)) -> list[dict]:
    records = (
        db.query(CollectionRecord)
        .options(joinedload(CollectionRecord.analysis_task))
        .order_by(CollectionRecord.created_at.desc())
        .all()
    )
    return [record_summary(record) for record in records]


@app.get("/api/records/{record_id}")
def get_record(record_id: int, db: Session = Depends(get_db)) -> dict:
    record = load_record(db, record_id)
    return {
        **record_summary(record),
        "age_group": record.age_group,
        "gender": record.gender,
        "language": record.language,
        "recording_environment": record.recording_environment,
        "transcript": record.transcript,
        "asr_result": record.asr_result,
        "analysis_result": record.analysis_result,
    }


@app.get("/api/records/{record_id}/audio")
def get_audio(record_id: int, db: Session = Depends(get_db)) -> StreamingResponse:
    record = load_record(db, record_id)
    return StreamingResponse(audio_cos_storage.stream(record.audio_path), media_type=record.audio_content_type)


@app.post("/api/records/{record_id}/analysis/retry")
def retry_analysis(record_id: int, db: Session = Depends(get_db)) -> dict:
    record = load_record(db, record_id)
    task = record.analysis_task
    if task is None:
        task = AnalysisTask(record_id=record.id, max_attempts=3)
        db.add(task)
    elif task.status in TASK_ACTIVE_STATUSES:
        raise HTTPException(status_code=409, detail="Analysis is already in progress")
    else:
        task.status = "pending"
        task.attempt_count = 0
        task.next_retry_at = None
        task.worker_id = None
        task.lease_expires_at = None
        task.started_at = None
        task.finished_at = None
        task.cancel_requested_at = None
        task.failed_stage = None
        task.error_code = None
        task.error_message = None
    db.commit()
    db.refresh(task)
    return {"record_id": record.id, "task": task_summary(task)}


@app.post("/api/records/{record_id}/analysis/cancel")
def cancel_analysis(record_id: int, db: Session = Depends(get_db)) -> dict:
    record = load_record(db, record_id)
    task = record.analysis_task
    if task is None or task.status not in TASK_ACTIVE_STATUSES:
        raise HTTPException(status_code=409, detail="No active analysis task to cancel")
    task.cancel_requested_at = datetime.utcnow()
    if task.status == "pending":
        task.status = "cancelled"
        task.finished_at = datetime.utcnow()
    db.commit()
    db.refresh(task)
    return {"record_id": record.id, "task": task_summary(task)}


@app.delete("/api/records/{record_id}")
def delete_record(record_id: int, db: Session = Depends(get_db)) -> dict[str, bool]:
    record = load_record(db, record_id)
    audio_cos_storage.delete(record.audio_path)
    db.delete(record)
    db.commit()
    return {"deleted": True}


@app.delete("/api/subjects/{subject_id}")
def delete_subject_records(subject_id: str, db: Session = Depends(get_db)) -> dict[str, int]:
    records = db.query(CollectionRecord).filter(CollectionRecord.subject_id == subject_id).all()
    for record in records:
        audio_cos_storage.delete(record.audio_path)
        db.delete(record)
    db.commit()
    return {"deleted_count": len(records)}
