import json
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from .cos_storage import audio_cos_storage
from .database import get_db
from .models import AnalysisTask, CollectionRecord, UploadSession

app = FastAPI(
    title="语音表达洞察演示 API",
    description="语音采集与实验性表达洞察演示，不提供医疗诊断服务。",
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
MAX_MULTIPART_PARTS = 10_000


def task_summary(task: AnalysisTask | None) -> dict | None:
    if task is None:
        return None
    return {
        "id": task.id,
        "status": task.status,
        "attempt_count": task.attempt_count,
        "max_attempts": task.max_attempts,
        "failed_stage": task.failed_stage,
        "error_code": task.error_code,
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
        raise HTTPException(status_code=404, detail="未找到该录音记录。")
    return record


@app.get("/api/health")
def health_check() -> dict[str, bool]:
    return {"ok": True}


def upload_session_summary(session: UploadSession) -> dict:
    return {
        "upload_id": session.id,
        "status": session.status,
        "total_bytes": session.total_bytes,
        "uploaded_parts": session.uploaded_parts or [],
        "record_id": session.record_id,
    }


def create_record_and_task(session: UploadSession, db: Session) -> CollectionRecord:
    subject = session.subject
    record = CollectionRecord(
        subject_id=str(subject["subject_id"]),
        age_group=subject.get("age_group"),
        gender=subject.get("gender"),
        language=subject.get("language", "普通话"),
        recording_environment=subject.get("recording_environment"),
        audio_path=session.object_key,
        audio_filename=session.audio_filename,
        audio_content_type=session.audio_content_type,
        idempotency_key=session.idempotency_key,
    )
    db.add_all((record, AnalysisTask(record=record, max_attempts=3)))
    db.flush()
    session.status = "completed"
    session.record_id = record.id
    return record


@app.post("/api/upload-sessions")
def create_upload_session(payload: dict, db: Session = Depends(get_db)) -> dict:
    subject = payload.get("subject") or {}
    subject_id = str(subject.get("subject_id", "")).strip()
    total_bytes = payload.get("total_bytes")
    idempotency_key = str(payload.get("idempotency_key", "")).strip()
    filename = str(payload.get("audio_filename") or "voice-sample.m4a")
    content_type = str(payload.get("audio_content_type") or "audio/mp4")
    suffix = Path(filename).suffix.lower() or ".m4a"
    if not subject_id or not idempotency_key:
        raise HTTPException(status_code=422, detail="匿名编号和请求幂等标识不能为空。")
    if not isinstance(total_bytes, int) or total_bytes <= 0:
        raise HTTPException(status_code=422, detail="录音文件大小必须为正整数。")
    if suffix not in {".m4a", ".aac"}:
        raise HTTPException(status_code=422, detail="仅支持 m4a 或 aac 格式的录音文件。")
    session = db.get(UploadSession, str(payload.get("upload_id") or "")) if payload.get("upload_id") else None
    if session is not None and session.idempotency_key != idempotency_key:
        raise HTTPException(status_code=409, detail="上传会话与当前录音不匹配。")
    if session is None:
        session = db.query(UploadSession).filter(UploadSession.idempotency_key == idempotency_key).one_or_none()
    if session is not None:
        if session.total_bytes != total_bytes:
            raise HTTPException(status_code=409, detail="上传会话中的文件大小与当前录音不匹配。")
        return upload_session_summary(session)
    object_key, cos_upload_id = audio_cos_storage.create_multipart_upload(suffix, content_type)
    session = UploadSession(
        id=str(uuid4()),
        subject=subject,
        audio_filename=filename,
        audio_content_type=content_type,
        total_bytes=total_bytes,
        object_key=object_key,
        cos_upload_id=cos_upload_id,
        uploaded_parts=[],
        idempotency_key=idempotency_key,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return upload_session_summary(session)


@app.get("/api/upload-sessions/{upload_id}")
def get_upload_session(upload_id: str, db: Session = Depends(get_db)) -> dict:
    session = db.get(UploadSession, upload_id)
    if session is None:
        raise HTTPException(status_code=404, detail="未找到上传会话。")
    return upload_session_summary(session)


@app.put("/api/upload-sessions/{upload_id}/parts/{part_number}")
async def upload_session_part(upload_id: str, part_number: int, request: Request, db: Session = Depends(get_db)) -> dict:
    session = db.get(UploadSession, upload_id)
    if session is None:
        raise HTTPException(status_code=404, detail="未找到上传会话。")
    if session.status != "uploading":
        raise HTTPException(status_code=409, detail="当前上传会话无法继续接收分片。")
    if part_number < 1 or part_number > MAX_MULTIPART_PARTS:
        raise HTTPException(status_code=422, detail="上传分片编号无效。")
    parts = session.uploaded_parts or []
    if any(part["part_number"] == part_number for part in parts):
        return upload_session_summary(session)
    body = await request.body()
    if not body:
        raise HTTPException(status_code=422, detail="上传分片不能为空。")
    etag = audio_cos_storage.upload_part(session.object_key, session.cos_upload_id, part_number, body)
    session.uploaded_parts = sorted([*parts, {"part_number": part_number, "etag": etag, "size": len(body)}], key=lambda part: part["part_number"])
    db.commit()
    db.refresh(session)
    return upload_session_summary(session)


@app.post("/api/upload-sessions/{upload_id}/complete")
def complete_upload_session(upload_id: str, payload: dict, db: Session = Depends(get_db)) -> dict:
    session = db.get(UploadSession, upload_id)
    if session is None:
        raise HTTPException(status_code=404, detail="未找到上传会话。")
    if session.status == "completed" and session.record_id is not None:
        record = load_record(db, session.record_id)
        return {"record_id": record.id, "task": task_summary(record.analysis_task), "idempotent": True}
    if session.status != "uploading":
        raise HTTPException(status_code=409, detail="当前上传会话无法完成提交。")
    part_count = payload.get("part_count")
    parts = session.uploaded_parts or []
    if not isinstance(part_count, int) or part_count < 1:
        raise HTTPException(status_code=422, detail="上传分片数量必须为正整数。")
    if [part["part_number"] for part in parts] != list(range(1, part_count + 1)):
        raise HTTPException(status_code=409, detail="部分上传分片缺失，请继续上传后再提交。")
    if sum(int(part["size"]) for part in parts) != session.total_bytes:
        raise HTTPException(status_code=409, detail="已上传文件大小与原始录音不一致。")
    try:
        audio_cos_storage.complete_multipart_upload(session.object_key, session.cos_upload_id, parts)
        record = create_record_and_task(session, db)
        db.commit()
    except Exception as error:
        db.rollback()
        raise HTTPException(status_code=502, detail="录音上传完成失败，请稍后重试。") from error
    db.refresh(record)
    db.refresh(record.analysis_task)
    return {"record_id": record.id, "task": task_summary(record.analysis_task), "idempotent": False}


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
        raise HTTPException(status_code=422, detail="匿名信息格式无效。") from error

    subject_id = str(subject_data.get("subject_id", "")).strip()
    if not subject_id:
        raise HTTPException(status_code=422, detail="匿名编号不能为空。")
    if not idempotency_key.strip():
        raise HTTPException(status_code=422, detail="请求幂等标识不能为空。")

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
        raise HTTPException(status_code=422, detail="仅支持 m4a 或 aac 格式的录音文件。")

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
        raise HTTPException(status_code=409, detail="当前录音正在转录或分析中。")
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
        raise HTTPException(status_code=409, detail="当前没有可取消的分析任务。")
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
