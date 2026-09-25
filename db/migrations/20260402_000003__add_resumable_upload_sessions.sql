CREATE TABLE upload_sessions (
    id VARCHAR(36) NOT NULL,
    subject JSON NOT NULL,
    audio_filename VARCHAR(255) NOT NULL,
    audio_content_type VARCHAR(128) NOT NULL,
    total_bytes BIGINT NOT NULL,
    object_key VARCHAR(512) NOT NULL,
    cos_upload_id VARCHAR(512) NOT NULL,
    uploaded_parts JSON NOT NULL,
    status VARCHAR(32) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    record_id BIGINT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_upload_sessions_object_key (object_key),
    UNIQUE KEY uq_upload_sessions_idempotency_key (idempotency_key),
    INDEX ix_upload_sessions_status (status),
    CONSTRAINT fk_upload_sessions_record_id FOREIGN KEY (record_id)
        REFERENCES collection_records (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
