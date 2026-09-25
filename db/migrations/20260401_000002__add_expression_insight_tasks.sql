ALTER TABLE collection_records
    DROP COLUMN phq9_answers,
    DROP COLUMN mbti_answers,
    ADD COLUMN language VARCHAR(32) NULL AFTER gender,
    ADD COLUMN recording_environment VARCHAR(64) NULL AFTER language,
    ADD COLUMN audio_filename VARCHAR(255) NULL AFTER audio_path,
    ADD COLUMN audio_content_type VARCHAR(128) NULL AFTER audio_filename,
    ADD COLUMN idempotency_key VARCHAR(128) NULL AFTER audio_content_type,
    ADD COLUMN transcript TEXT NULL AFTER idempotency_key,
    ADD COLUMN asr_result JSON NULL AFTER transcript,
    ADD COLUMN updated_at DATETIME NULL AFTER created_at;

UPDATE collection_records
SET
    audio_filename = CONCAT('legacy-', id, '.m4a'),
    audio_content_type = 'audio/mp4',
    idempotency_key = UUID(),
    updated_at = COALESCE(created_at, UTC_TIMESTAMP());

ALTER TABLE collection_records
    MODIFY COLUMN audio_filename VARCHAR(255) NOT NULL,
    MODIFY COLUMN audio_content_type VARCHAR(128) NOT NULL,
    MODIFY COLUMN idempotency_key VARCHAR(128) NOT NULL,
    MODIFY COLUMN updated_at DATETIME NOT NULL,
    ADD UNIQUE KEY uq_collection_records_idempotency_key (idempotency_key);

CREATE TABLE analysis_tasks (
    id BIGINT NOT NULL AUTO_INCREMENT,
    record_id BIGINT NOT NULL,
    status VARCHAR(32) NOT NULL,
    attempt_count INT NOT NULL,
    max_attempts INT NOT NULL,
    next_retry_at DATETIME NULL,
    worker_id VARCHAR(128) NULL,
    lease_expires_at DATETIME NULL,
    started_at DATETIME NULL,
    finished_at DATETIME NULL,
    cancel_requested_at DATETIME NULL,
    failed_stage VARCHAR(32) NULL,
    error_code VARCHAR(64) NULL,
    error_message VARCHAR(512) NULL,
    asr_request_id VARCHAR(128) NULL,
    deepseek_request_id VARCHAR(128) NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_analysis_tasks_record_id (record_id),
    INDEX ix_analysis_tasks_status_next_retry (status, next_retry_at),
    INDEX ix_analysis_tasks_lease_expires_at (lease_expires_at),
    CONSTRAINT fk_analysis_tasks_record_id FOREIGN KEY (record_id)
        REFERENCES collection_records (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
