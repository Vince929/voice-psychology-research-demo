"""Deleting a session must cascade-clean everything: DB rows (messages,
strategy records) and the on-disk audio files (bonus feature: 删除会话及相关音频数据)."""

from pathlib import Path

from app.config import UPLOAD_AUDIO_DIR
from app.database import SessionLocal
from app.models import Message

from conftest import send_message


def test_delete_session_removes_rows_and_audio_files(auth_client, active_session):
    session_id = active_session["id"]

    # Give the session one real turn (adds user+assistant messages and a record)
    # and one synthetic voice message row with an actual file on disk.
    reply = send_message(auth_client, session_id, "我最近总是睡不好。")
    assert reply.status_code == 200, reply.text

    db = SessionLocal()
    try:
        db.add(Message(session_id=session_id, role="user", content="synthetic", audio_path=f"{session_id}/synthetic.m4a"))
        db.commit()
    finally:
        db.close()

    audio_dir = Path(UPLOAD_AUDIO_DIR) / str(session_id)
    audio_dir.mkdir(parents=True, exist_ok=True)
    audio_file = audio_dir / "synthetic.m4a"
    audio_file.write_bytes(b"fake-m4a-bytes")
    assert audio_file.is_file()

    response = auth_client.delete(f"/api/sessions/{session_id}")
    assert response.status_code == 200, response.text

    # Session gone (404, also for the owner) and audio file + directory gone.
    assert auth_client.get(f"/api/sessions/{session_id}").status_code == 404
    assert not audio_file.exists()
    assert not audio_dir.exists()

    db = SessionLocal()
    try:
        remaining = db.query(Message).filter(Message.session_id == session_id).count()
    finally:
        db.close()
    assert remaining == 0


def test_deleted_session_is_invisible_to_cross_user_access(client, auth_client, active_session, demo2_token):
    session_id = active_session["id"]
    assert auth_client.delete(f"/api/sessions/{session_id}").status_code == 200
    response = client.get(
        f"/api/sessions/{session_id}", headers={"Authorization": f"Bearer {demo2_token}"}
    )
    assert response.status_code == 404
