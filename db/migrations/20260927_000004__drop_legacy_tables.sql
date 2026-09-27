-- Drop legacy single-turn collection tables (replaced by agent tables in the next migration).
DROP TABLE IF EXISTS analysis_tasks;
DROP TABLE IF EXISTS upload_sessions;
DROP TABLE IF EXISTS collection_records;
