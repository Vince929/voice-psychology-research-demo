"""Audit-trail helper (bonus feature: sensitive-data governance).

Every entry stores only: which user, which action, which session, and small
structured metadata (e.g. technique/risk enums). Message content, transcripts
and other free-form user text are deliberately never passed in here, so the
audit table and application logs stay free of PHI by construction.
"""

import logging

from .models import AuditLog

logger = logging.getLogger(__name__)


def record_audit(db, *, user_id: int | None, action: str, session_id: int | None = None, detail: dict | None = None) -> None:
    """Append one audit entry. Caller owns the transaction (commit)."""
    db.add(AuditLog(user_id=user_id, action=action, session_id=session_id, detail=detail))
