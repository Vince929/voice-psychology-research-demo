import logging
import re
from datetime import datetime
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import ValidationError
from sqlalchemy.orm import Session

from .analysis_services import (
    ExternalServiceError,
    extract_asr_features,
    extract_audio_features,
    transcribe_m4a,
)
from .auth import create_token, decode_token, get_current_user, verify_password
from .config import UPLOAD_AUDIO_DIR
from .database import get_db
from .models import ChatSession, Message, User
from .schemas import LoginRequest, MessageTextRequest, SessionCreate
from .strategy import _message_summary, _record_summary, process_turn
from .summary import generate_summary

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


@app.exception_handler(ExternalServiceError)
def external_service_error_handler(_request: Request, error: ExternalServiceError) -> JSONResponse:
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
        raise HTTPException(status_code=401, detail="用户名或密码不正确。")
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
        rejected_techniques=[],
    )
    db.add(session)
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

    content_type = request.headers.get("content-type", "")
    text: str
    asr_features = None
    audio_path: str | None = None

    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        upload = form.get("audio")
        if not isinstance(upload, UploadFile):
            raise HTTPException(status_code=422, detail="语音消息必须包含 audio 文件。")
        audio_bytes = await upload.read()
        if not audio_bytes:
            raise HTTPException(status_code=422, detail="音频文件不能为空。")
        text, asr_features, audio_path = await _process_voice_message(session.id, upload, audio_bytes)
    else:
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
        text = payload.text.strip()

    result = process_turn(db, session, text, asr_features=asr_features, audio_path=audio_path)
    db.commit()
    return result


async def _process_voice_message(session_id: int, upload: UploadFile, audio_bytes: bytes) -> tuple[str, dict, str]:
    transcript, asr_result, _request_id = transcribe_m4a(audio_bytes)
    if not transcript or not transcript.strip():
        raise ExternalServiceError(
            "transcription", "未能从这段录音中识别出内容，请靠近麦克风重新录制后重试。", False
        )
    asr_features = extract_asr_features(transcript, asr_result)
    loudness = extract_audio_features(audio_bytes)
    if loudness:
        asr_features["audio_features"] = loudness

    match = AUDIO_SUFFIX_PATTERN.search(upload.filename or "")
    suffix = match.group(0) if match else ".m4a"
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
    return FileResponse(audio_file, media_type="audio/mp4")


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
    db.delete(session)
    db.commit()
    return {"ok": True}
