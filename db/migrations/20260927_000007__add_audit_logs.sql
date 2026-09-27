-- Audit log (bonus feature: sensitive-data governance). Stores actions and
-- structured metadata only -- never message content or transcripts.
-- IF NOT EXISTS keeps it safe on databases where the table was created by
-- an earlier incarnation of migration 000006.
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT NOT NULL AUTO_INCREMENT,
    user_id BIGINT NULL,
    action VARCHAR(32) NOT NULL,
    session_id BIGINT NULL,
    detail JSON NULL,
    created_at DATETIME NOT NULL,
    PRIMARY KEY (id),
    KEY ix_audit_logs_user_id (user_id),
    KEY ix_audit_logs_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
