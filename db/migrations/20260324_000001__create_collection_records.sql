CREATE TABLE collection_records (
    id BIGINT NOT NULL AUTO_INCREMENT,
    subject_id VARCHAR(128) NOT NULL,
    age_group VARCHAR(32) NULL,
    gender VARCHAR(32) NULL,
    audio_path VARCHAR(512) NOT NULL,
    phq9_answers JSON NOT NULL,
    mbti_answers JSON NOT NULL,
    analysis_result JSON NULL,
    created_at DATETIME NOT NULL,
    PRIMARY KEY (id),
    INDEX ix_collection_records_subject_id (subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
