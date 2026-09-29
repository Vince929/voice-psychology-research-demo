import json
import logging
import re
import time
from datetime import datetime
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
# NOTE: request.form() yields starlette's UploadFile, not fastapi's subclass --
# isinstance checks must use the starlette class or every voice upload is
# rejected with 422.
from starlette.datastructures import UploadFile
from pydantic import ValidationError
from sqlalchemy.orm import Session

from .analysis_services import (
    ExternalServiceError,
    extract_asr_features,
    extract_audio_features,
    stream_deepseek_json,
    transcribe_m4a,
)
from .audit import record_audit
from .auth import create_token, decode_token, get_current_user, verify_password
from .config import UPLOAD_AUDIO_DIR
from .database import get_db
from .models import ChatSession, Message, User
from .schemas import LoginRequest, MessageTextRequest, ReplyFeedbackUpdate, SessionCreate, SessionPreferenceUpdate
from .strategy import _message_summary, _record_summary, process_turn, turn_event_stream
from .summary import generate_summary

# Uvicorn only configures its own loggers; without this, app loggers fall back
# to the WARNING-level root default and logger.info(...) is dropped (e.g.
# DEBUG_LLM_PROMPT output in strategy.py).
logging.basicConfig(level=logging.INFO)

app = FastAPI(
    title="焦虑人群语音心理支持 Agent API",
    description="非医疗性质的辅助性心理支持工具，不作诊断、不作治疗承诺、不替代专业援助。",
    version="1.0.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost", "http://127.0.0.1"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logger = logging.getLogger(__name__)

AUDIO_SUFFIX_PATTERN = re.compile(r"\.(m4a|aac)$", re.IGNORECASE)


@app.middleware("http")
async def log_requests_sanitized(request: Request, call_next):
    """Traffic logging with redaction by construction: only the method, path
    (no query bodies are read) and status/duration are logged -- request
    bodies, message text and transcripts never enter application logs."""
    started = time.perf_counter()
    response = await call_next(request)
    duration_ms = (time.perf_counter() - started) * 1000
    logger.info(
        "http %s %s -> %s (%.0fms)",
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
    )
    return response


@app.exception_handler(ExternalServiceError)
def external_service_error_handler(_request: Request, error: ExternalServiceError) -> JSONResponse:
    # Log the failure itself (stage/retryability only, never user content)
    # and surface an explicit error to the client -- never pretend success.
    logger.error("external service unavailable: stage=%s retryable=%s: %s", error.stage, error.retryable, error)
    return JSONResponse(
        status_code=502,
        content={"detail": str(error), "stage": error.stage, "retryable": error.retryable},
    )


def _session_summary(session: ChatSession) -> dict:
    return {
        "id": session.id,
        "concern": session.concern,
        "expression_preference": session.expression_preference,
        "voice_reply_enabled": session.voice_reply_enabled,
        "voice_profile_override": session.voice_profile_override,
        "status": session.status,
        "max_risk_level": session.max_risk_level,
        "safety_triggered": session.safety_triggered,
        "rejected_techniques": list(session.rejected_techniques or []),
        "summary": session.summary,
        "created_at": session.created_at,
        "ended_at": session.ended_at,
    }


def _session_detail(session: ChatSession) -> dict:
    records_by_message = {record.message_id: record for record in session.strategy_records}
    messages = []
    for message in session.messages:
        item = _message_summary(message)
        record = records_by_message.get(message.id)
        item["strategy_record"] = _record_summary(record) if record else None
        messages.append(item)
    return {
        **_session_summary(session),
        "messages": messages,
        "strategy_records": [_record_summary(record) for record in session.strategy_records],
    }


def _load_session(db: Session, user: User, session_id: int) -> ChatSession:
    session = db.get(ChatSession, session_id)
    # Ownership filter first: 404 for both "not found" and "someone else's" (no existence leak).
    if session is None or session.user_id != user.id:
        raise HTTPException(status_code=404, detail="未找到该会话。")
    return session


@app.get("/api/health")
def health_check() -> dict[str, bool]:
    return {"ok": True}


@app.post("/api/auth/login")
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> dict:
    user = db.query(User).filter(User.username == payload.username.strip()).one_or_none()
    if user is None or not verify_password(payload.password, user.password_hash):
        record_audit(db, user_id=None, action="login_failed", detail={"username": payload.username.strip()})
        db.commit()
        raise HTTPException(status_code=401, detail="用户名或密码不正确。")
    record_audit(db, user_id=user.id, action="login")
    db.commit()
    return {"token": create_token(user), "username": user.username}


@app.post("/api/auth/logout")
def logout(_user: User = Depends(get_current_user)) -> dict[str, bool]:
    # Stateless JWT: the client clears the local token; endpoint kept for semantic completeness.
    return {"ok": True}


@app.get("/api/auth/me")
def me(user: User = Depends(get_current_user)) -> dict:
    return {"id": user.id, "username": user.username}


@app.post("/api/sessions")
def create_session(
    payload: SessionCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    session = ChatSession(
        user=user,
        concern=payload.concern.strip(),
        expression_preference=payload.expression_preference,
        voice_reply_enabled=payload.voice_reply_enabled,
        voice_profile_override=payload.voice_profile_override,
        rejected_techniques=[],
    )
    db.add(session)
    db.flush()  # populate session.id before the audit row references it
    record_audit(db, user_id=user.id, action="session_create", session_id=session.id)
    db.commit()
    db.refresh(session)
    return _session_summary(session)


@app.get("/api/sessions")
def list_sessions(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    sessions = (
        db.query(ChatSession)
        .filter(ChatSession.user_id == user.id)
        .order_by(ChatSession.created_at.desc())
        .all()
    )
    return [_session_summary(session) for session in sessions]


@app.get("/api/sessions/{session_id}")
def get_session(
    session_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    return _session_detail(_load_session(db, user, session_id))


@app.patch("/api/messages/{message_id}/feedback")
def update_reply_feedback(
    message_id: int,
    payload: ReplyFeedbackUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Persist a reply rating. Marking a normal strategy unhelpful adds its
    technique to the session rejection memory used by every subsequent turn."""
    message = db.get(Message, message_id)
    if message is None or message.role != "assistant" or message.session is None or message.session.user_id != user.id:
        raise HTTPException(status_code=404, detail="未找到该助手回复。")
    record = message.strategy_record
    if record is None:
        raise HTTPException(status_code=409, detail="该回复没有可评价的策略记录。")

    record.feedback = payload.feedback
    technique_blocked = False
    if payload.feedback == "unhelpful" and record.technique != "safety_escalation":
        rejected = list(message.session.rejected_techniques or [])
        if record.technique not in rejected:
            rejected.append(record.technique)
            message.session.rejected_techniques = rejected
            technique_blocked = True
    record_audit(
        db,
        user_id=user.id,
        action="reply_feedback",
        session_id=message.session_id,
        detail={"message_id": message.id, "feedback": payload.feedback, "technique": record.technique},
    )
    db.commit()
    return {"message_id": message.id, "feedback": record.feedback, "technique_blocked": technique_blocked}


@app.patch("/api/sessions/{session_id}/preferences")
def update_session_preferences(
    session_id: int,
    payload: SessionPreferenceUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Let the user edit the Agent's voice style (bonus feature).

    `voice_profile_override=null` clears back to auto. The override never
    affects safety-escalation / high-anxiety turns -- enforced server-side in
    `resolve_turn_voice_profile`, not just hidden in the UI.
    """
    session = _load_session(db, user, session_id)
    if session.status != "active":
        raise HTTPException(status_code=409, detail="该会话已结束，无法修改偏好。")
    session.voice_profile_override = payload.voice_profile_override
    record_audit(
        db, user_id=user.id, action="session_preferences_update", session_id=session.id,
        detail={"voice_profile_override": payload.voice_profile_override},
    )
    db.commit()
    return _session_summary(session)


async def _parse_message_payload(request: Request, session_id: int) -> tuple[str, dict | None, str | None]:
    """Shared body parsing for the text/voice message endpoints: returns
    (text, asr_features, audio_path). Raises HTTPException on bad payloads."""
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        upload = form.get("audio")
        if not isinstance(upload, UploadFile):
            raise HTTPException(status_code=422, detail="语音消息必须包含 audio 文件。")
        audio_bytes = await upload.read()
        if not audio_bytes:
            raise HTTPException(status_code=422, detail="音频文件不能为空。")
        return await _process_voice_message(session_id, upload, audio_bytes)
    try:
        body = await request.json()
    except Exception as error:
        raise HTTPException(status_code=422, detail="请求体必须是合法 JSON。") from error
    try:
        payload = MessageTextRequest.model_validate(body)
    except ValidationError as error:
        raise HTTPException(
            status_code=422, detail=f"消息内容不合法：{error.errors()[0]['msg']}"
        ) from error
    return payload.text.strip(), None, None


@app.post("/api/sessions/{session_id}/messages")
async def post_message(
    session_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    session = _load_session(db, user, session_id)
    if session.status != "active":
        raise HTTPException(status_code=409, detail="该会话已结束，无法继续发送消息。")

    text, asr_features, audio_path = await _parse_message_payload(request, session.id)

    result = process_turn(db, session, text, asr_features=asr_features, audio_path=audio_path)
    db.commit()
    return result


def _sse_encode(event: dict) -> str:
    # jsonable_encoder mirrors what the non-streaming JSON endpoint produces
    # (datetime -> ISO string), so the final `result` event matches the shape
    # the app already expects; plain json.dumps would raise on datetimes.
    return f"data: {json.dumps(jsonable_encoder(event), ensure_ascii=False)}\n\n"


@app.post("/api/sessions/{session_id}/messages/stream")
async def post_message_stream(
    session_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StreamingResponse:
    """SSE variant of POST /messages: streams reply-text deltas while the
    LLM generates, then one final `result` event with the authoritative
    payload (same shape as the non-streaming endpoint).

    Event protocol, one JSON object per SSE `data:` line:
      {"type": "delta", "text": "..."}        incremental assistant reply fragment
      {"type": "reset", "reason": "..."}      previous fragments dropped, regenerating
      {"type": "result", "result": {...}}      final persisted turn payload
      {"type": "error", "detail": "...", "stage": "...", "retryable": bool}

    Voice uploads run ASR first (inside this request, before the stream
    starts), then stream the LLM reply. Deltas are display-only: the final
    `result` event is the validated, persisted content and replaces whatever
    was streamed (constraint truncation / safety replies included).
    """
    session = _load_session(db, user, session_id)
    if session.status != "active":
        raise HTTPException(status_code=409, detail="该会话已结束，无法继续发送消息。")

    text, asr_features, audio_path = await _parse_message_payload(request, session.id)

    def event_stream():
        try:
            for event in turn_event_stream(
                db,
                session,
                text,
                asr_features=asr_features,
                audio_path=audio_path,
                stream_call=stream_deepseek_json,
            ):
                if event["type"] == "result":
                    db.commit()
                yield _sse_encode(event)
        except ExternalServiceError as error:
            db.rollback()
            logger.error(
                "external service unavailable: stage=%s retryable=%s: %s", error.stage, error.retryable, error
            )
            yield _sse_encode(
                {"type": "error", "detail": str(error), "stage": error.stage, "retryable": error.retryable}
            )
        except Exception:
            db.rollback()
            logger.exception("streaming turn failed unexpectedly")
            yield _sse_encode(
                {"type": "error", "detail": "服务器内部错误，请稍后重试。", "stage": "server", "retryable": True}
            )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _process_voice_message(session_id: int, upload: UploadFile, audio_bytes: bytes) -> tuple[str, dict, str]:
    match = AUDIO_SUFFIX_PATTERN.search(upload.filename or "")
    suffix = match.group(0) if match else ".m4a"
    # Pass the real container format to ASR so uploaded .aac files are not
    # mis-declared as m4a (the flash ASR parses per voice_format).
    voice_format = suffix.lstrip(".").lower()
    transcript, asr_result, _request_id = transcribe_m4a(audio_bytes, voice_format)
    if not transcript or not transcript.strip():
        raise ExternalServiceError(
            "transcription", "未能从这段录音中识别出内容，请靠近麦克风重新录制后重试。", False
        )
    asr_features = extract_asr_features(transcript, asr_result)
    loudness = extract_audio_features(audio_bytes)
    if loudness:
        asr_features["audio_features"] = loudness
    directory = UPLOAD_AUDIO_DIR / str(session_id)
    directory.mkdir(parents=True, exist_ok=True)
    saved_name = f"{uuid4().hex}{suffix}"
    relative_path = f"{session_id}/{saved_name}"
    (directory / saved_name).write_bytes(audio_bytes)
    return transcript, asr_features, relative_path


@app.get("/api/messages/{message_id}/audio")
def get_message_audio(
    message_id: int,
    request: Request,
    token: str = "",
    db: Session = Depends(get_db),
) -> FileResponse:
    # The native player cannot attach headers, so a ?token= query fallback is allowed.
    authorization = request.headers.get("authorization", "")
    if authorization.startswith("Bearer ") and not token:
        token = authorization[len("Bearer ") :].strip()
    if not token:
        raise HTTPException(status_code=401, detail="请先登录后再访问。")
    payload = decode_token(token)
    try:
        user_id = int(payload["sub"])
    except (KeyError, ValueError, TypeError) as error:
        raise HTTPException(status_code=401, detail="登录状态无效，请重新登录。") from error

    message = db.get(Message, message_id)
    if message is None or message.audio_path is None:
        raise HTTPException(status_code=404, detail="未找到该语音消息。")
    if message.session is None or message.session.user_id != user_id:
        raise HTTPException(status_code=404, detail="未找到该语音消息。")

    audio_file = (UPLOAD_AUDIO_DIR / message.audio_path).resolve()
    if not str(audio_file).startswith(str(UPLOAD_AUDIO_DIR.resolve())) or not audio_file.is_file():
        raise HTTPException(status_code=404, detail="未找到该语音消息。")
    return FileResponse(
        audio_file,
        media_type="audio/mp4",
        headers={"Cache-Control": "private, max-age=86400"},
    )


@app.post("/api/sessions/{session_id}/end")
def end_session(
    session_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    session = _load_session(db, user, session_id)
    if session.status == "ended" and session.summary:
        return {"summary": session.summary, "idempotent": True}
    if session.status == "ended" and not session.summary:
        raise HTTPException(status_code=409, detail="该会话总结生成失败过，请重新生成。")

    summary = generate_summary(session)
    session.summary = summary
    session.status = "ended"
    session.ended_at = datetime.utcnow()
    record_audit(db, user_id=user.id, action="session_end", session_id=session.id,
                 detail={"safety_ever_triggered": session.safety_triggered})
    db.commit()
    return {"summary": summary, "idempotent": False}


@app.delete("/api/sessions/{session_id}")
def delete_session(
    session_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, bool]:
    session = _load_session(db, user, session_id)
    for message in session.messages:
        if message.audio_path:
            audio_file = UPLOAD_AUDIO_DIR / message.audio_path
            if audio_file.is_file():
                audio_file.unlink()
    # Remove the (now empty) per-session audio directory, best effort.
    session_audio_dir = UPLOAD_AUDIO_DIR / str(session_id)
    try:
        session_audio_dir.rmdir()
    except OSError:
        pass
    db.delete(session)
    record_audit(db, user_id=user.id, action="session_delete", session_id=session_id)
    db.commit()
    return {"ok": True}
