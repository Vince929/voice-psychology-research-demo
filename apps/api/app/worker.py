import logging
import os
import socket
import time
from datetime import datetime, timedelta

from sqlalchemy.orm import joinedload

from .analysis_services import ExternalServiceError, analyze_expression, transcribe_m4a
from .config import TASK_MAX_ATTEMPTS, WORKER_LEASE_SECONDS, WORKER_POLL_INTERVAL_SECONDS
from .cos_storage import audio_cos_storage
from .database import SessionLocal
from .models import AnalysisTask

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger(__name__)
WORKER_ID = f"{socket.gethostname()}-{os.getpid()}"


def recover_expired_leases() -> None:
    now = datetime.utcnow()
    with SessionLocal() as db:
        expired = (
            db.query(AnalysisTask)
            .filter(
                AnalysisTask.status.in_(("transcribing", "analyzing")),
                AnalysisTask.lease_expires_at.is_not(None),
                AnalysisTask.lease_expires_at < now,
            )
            .all()
        )
        for task in expired:
            if task.cancel_requested_at is not None:
                task.status = "cancelled"
                task.finished_at = now
            elif task.attempt_count >= task.max_attempts:
                task.status = "failed"
                task.failed_stage = "worker"
                task.error_message = "分析任务处理超时，请重新分析。"
                task.finished_at = now
            else:
                task.status = "pending"
                task.worker_id = None
                task.lease_expires_at = None
                task.next_retry_at = now
        db.commit()


def claim_task() -> int | None:
    now = datetime.utcnow()
    with SessionLocal() as db:
        task = (
            db.query(AnalysisTask)
            .filter(
                AnalysisTask.status == "pending",
                (AnalysisTask.next_retry_at.is_(None)) | (AnalysisTask.next_retry_at <= now),
            )
            .order_by(AnalysisTask.created_at.asc())
            .with_for_update(skip_locked=True)
            .first()
        )
        if task is None:
            return None
        if task.cancel_requested_at is not None:
            task.status = "cancelled"
            task.finished_at = now
            db.commit()
            return None
        task.status = "transcribing"
        task.attempt_count += 1
        task.max_attempts = TASK_MAX_ATTEMPTS
        task.worker_id = WORKER_ID
        task.started_at = now
        task.lease_expires_at = now + timedelta(seconds=WORKER_LEASE_SECONDS)
        task.error_code = None
        task.error_message = None
        task.failed_stage = None
        db.commit()
        return task.id


def is_cancelled(task_id: int) -> bool:
    with SessionLocal() as db:
        task = db.get(AnalysisTask, task_id)
        return task is None or task.cancel_requested_at is not None or task.status == "cancelled"


def mark_cancelled(task_id: int) -> None:
    with SessionLocal() as db:
        task = db.get(AnalysisTask, task_id)
        if task is not None:
            task.status = "cancelled"
            task.finished_at = datetime.utcnow()
            task.lease_expires_at = None
            db.commit()


def process_task(task_id: int) -> None:
    with SessionLocal() as db:
        task = db.query(AnalysisTask).options(joinedload(AnalysisTask.record)).filter(AnalysisTask.id == task_id).one_or_none()
        if task is None or task.record is None:
            return
        audio_path = task.record.audio_path

    try:
        if is_cancelled(task_id):
            mark_cancelled(task_id)
            return
        transcript, asr_result, asr_request_id = transcribe_m4a(audio_cos_storage.read(audio_path))
        if is_cancelled(task_id):
            mark_cancelled(task_id)
            return

        with SessionLocal() as db:
            task = db.query(AnalysisTask).options(joinedload(AnalysisTask.record)).filter(AnalysisTask.id == task_id).one()
            task.record.transcript = transcript
            task.record.asr_result = asr_result
            task.asr_request_id = asr_request_id
            task.lease_expires_at = None
            if transcript is None:
                task.status = "completed"
                task.error_code = "no_speech_detected"
                task.error_message = "未识别到有效语音内容，请确认录音时已靠近麦克风并清晰朗读。"
                task.finished_at = datetime.utcnow()
                db.commit()
                logger.info("analysis completed without transcript task_id=%s", task_id)
                return
            task.status = "analyzing"
            task.lease_expires_at = datetime.utcnow() + timedelta(seconds=WORKER_LEASE_SECONDS)
            db.commit()

        analysis_result, deepseek_request_id = analyze_expression(transcript, asr_result)
        if is_cancelled(task_id):
            mark_cancelled(task_id)
            return

        with SessionLocal() as db:
            task = db.query(AnalysisTask).options(joinedload(AnalysisTask.record)).filter(AnalysisTask.id == task_id).one()
            task.record.analysis_result = analysis_result
            task.deepseek_request_id = deepseek_request_id
            task.status = "completed"
            task.finished_at = datetime.utcnow()
            task.lease_expires_at = None
            db.commit()
        logger.info("analysis completed task_id=%s", task_id)
    except ExternalServiceError as error:
        finish_failure(task_id, error.stage, str(error), error.retryable)
    except Exception:
        logger.exception("analysis task crashed task_id=%s", task_id)
        finish_failure(task_id, "worker", "分析任务处理异常，系统将自动重试。", True)


def finish_failure(task_id: int, stage: str, message: str, retryable: bool) -> None:
    now = datetime.utcnow()
    with SessionLocal() as db:
        task = db.get(AnalysisTask, task_id)
        if task is None:
            return
        if task.cancel_requested_at is not None:
            task.status = "cancelled"
            task.finished_at = now
        elif retryable and task.attempt_count < task.max_attempts:
            task.status = "pending"
            task.next_retry_at = now + timedelta(seconds=2 ** task.attempt_count)
            task.worker_id = None
            task.lease_expires_at = None
            task.error_code = "retry_scheduled"
            task.error_message = message[:512]
            task.failed_stage = stage
        else:
            task.status = "failed"
            task.finished_at = now
            task.lease_expires_at = None
            task.error_code = "analysis_failed"
            task.error_message = message[:512]
            task.failed_stage = stage
        db.commit()


def run() -> None:
    logger.info("analysis worker started worker_id=%s", WORKER_ID)
    while True:
        recover_expired_leases()
        task_id = claim_task()
        if task_id is None:
            time.sleep(WORKER_POLL_INTERVAL_SECONDS)
            continue
        process_task(task_id)


if __name__ == "__main__":
    run()
