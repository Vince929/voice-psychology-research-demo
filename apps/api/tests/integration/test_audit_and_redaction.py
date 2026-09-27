"""Bonus feature: audit trail + log redaction.

- Key actions (login / login_failed / session_create / session_delete /
  safety_escalation / session_end / preference update) are recorded in the
  append-only `audit_logs` table with structured metadata only.
- Message content never leaks into application logs or the audit table.
"""

import json
import logging

from app.database import SessionLocal
from app.models import AuditLog

from conftest import send_message


def _audit_rows(action: str, session_id: int | None = None) -> list[AuditLog]:
    db = SessionLocal()
    try:
        query = db.query(AuditLog).filter(AuditLog.action == action)
        if session_id is not None:
            query = query.filter(AuditLog.session_id == session_id)
        return query.order_by(AuditLog.id.desc()).limit(5).all()
    finally:
        db.close()


def _audit_count(action: str) -> int:
    # Exact count (not len of the limited "latest 5" helper): the shared dev
    # database accumulates rows across runs, which would saturate the limit
    # and make "after >= before + 1" impossible to satisfy.
    db = SessionLocal()
    try:
        return db.query(AuditLog).filter(AuditLog.action == action).count()
    finally:
        db.close()


def test_login_is_audited(client):
    response = client.post("/api/auth/login", json={"username": "demo1", "password": "Passw0rd!"})
    assert response.status_code == 200
    rows = _audit_rows("login")
    assert rows, "a successful login must be audited"


def test_failed_login_is_audited(client):
    before = _audit_count("login_failed")
    response = client.post("/api/auth/login", json={"username": "demo1", "password": "wrong"})
    assert response.status_code == 401
    assert _audit_count("login_failed") >= before + 1


def test_safety_escalation_is_audited_and_redacted(auth_client, active_session, caplog):
    session_id = active_session["id"]
    marker = "MARKER-绝不能出现在日志里-8471"

    with caplog.at_level(logging.INFO):
        response = send_message(auth_client, session_id, f"{marker}我想自杀")
        assert response.status_code == 200, response.text

    # 1) The safety escalation is audited with metadata only.
    rows = _audit_rows("safety_escalation", session_id)
    assert rows, "safety escalation must be audited"
    detail = rows[0].detail or {}
    assert detail.get("technique") == "safety_escalation"
    assert detail.get("risk_level") == "high"

    # 2) Neither the audit rows nor any captured log record contain the user text.
    assert marker not in json.dumps(detail, ensure_ascii=False)
    for record in caplog.records:
        assert marker not in record.getMessage(), record.getMessage()


def test_delete_is_audited(auth_client, active_session):
    session_id = active_session["id"]
    assert auth_client.delete(f"/api/sessions/{session_id}").status_code == 200
    rows = _audit_rows("session_delete", session_id)
    assert rows, "session deletion must be audited"


def test_preference_update_is_audited(auth_client, active_session):
    session_id = active_session["id"]
    response = auth_client.patch(
        f"/api/sessions/{session_id}/preferences", json={"voice_profile_override": "warm_normal"}
    )
    assert response.status_code == 200, response.text
    rows = _audit_rows("session_preferences_update", session_id)
    assert rows
    assert (rows[0].detail or {}).get("voice_profile_override") == "warm_normal"
