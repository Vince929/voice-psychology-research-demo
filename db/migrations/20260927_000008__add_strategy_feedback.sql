-- Per-assistant-reply helpfulness rating. NULL means the user has not rated it.
ALTER TABLE strategy_records
    ADD COLUMN feedback VARCHAR(16) NULL AFTER source;
