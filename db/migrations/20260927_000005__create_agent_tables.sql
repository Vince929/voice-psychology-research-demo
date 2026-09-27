CREATE TABLE users (
    id BIGINT NOT NULL AUTO_INCREMENT,
    username VARCHAR(64) NOT NULL,
    password_hash VARCHAR(128) NOT NULL,
    created_at DATETIME NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sessions (
    id BIGINT NOT NULL AUTO_INCREMENT,
    user_id BIGINT NOT NULL,
    concern VARCHAR(255) NOT NULL,
    expression_preference VARCHAR(16) NOT NULL,
    voice_reply_enabled TINYINT(1) NOT NULL DEFAULT 1,
    rejected_techniques JSON NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    max_risk_level VARCHAR(16) NOT NULL DEFAULT 'normal',
    safety_triggered TINYINT(1) NOT NULL DEFAULT 0,
    summary JSON NULL,
    created_at DATETIME NOT NULL,
    ended_at DATETIME NULL,
    PRIMARY KEY (id),
    KEY ix_sessions_user_id (user_id),
    CONSTRAINT fk_sessions_user_id FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE messages (
    id BIGINT NOT NULL AUTO_INCREMENT,
    session_id BIGINT NOT NULL,
    role VARCHAR(16) NOT NULL,
    content TEXT NOT NULL,
    audio_path VARCHAR(512) NULL,
    asr_features JSON NULL,
    created_at DATETIME NOT NULL,
    PRIMARY KEY (id),
    KEY ix_messages_session_id (session_id),
    CONSTRAINT fk_messages_session_id FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE strategy_records (
    id BIGINT NOT NULL AUTO_INCREMENT,
    session_id BIGINT NOT NULL,
    message_id BIGINT NOT NULL,
    anxiety_level VARCHAR(16) NOT NULL,
    risk_level VARCHAR(16) NOT NULL,
    observed_signals JSON NOT NULL,
    support_goal VARCHAR(512) NOT NULL,
    technique VARCHAR(32) NOT NULL,
    technique_reason VARCHAR(512) NOT NULL,
    response_constraints JSON NOT NULL,
    voice_profile VARCHAR(32) NOT NULL,
    tts_params JSON NOT NULL,
    avoided_techniques JSON NOT NULL,
    is_safety_escalation TINYINT(1) NOT NULL DEFAULT 0,
    source VARCHAR(8) NOT NULL,
    created_at DATETIME NOT NULL,
    PRIMARY KEY (id),
    KEY ix_strategy_records_session_id (session_id),
    CONSTRAINT fk_strategy_records_session_id FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
    CONSTRAINT fk_strategy_records_message_id FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
