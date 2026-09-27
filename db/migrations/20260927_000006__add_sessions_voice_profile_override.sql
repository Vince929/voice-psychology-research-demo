-- Recreates the migration whose file went missing after it had already been
-- applied to the shared database (yoyo tracks migrations by filename id, so
-- restoring the exact id keeps the applied history consistent). The column
-- already exists on databases that ran the original migration; this file is
-- what a fresh database rebuild runs to add it.
ALTER TABLE sessions
    ADD COLUMN voice_profile_override VARCHAR(32) NULL AFTER voice_reply_enabled;
