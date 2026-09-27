-- Test accounts for acceptance review. Password for both accounts: Passw0rd!
-- Hashes are standard bcrypt ($2b$10$), generated and verified offline.
-- Apply after migrations with: mysql <db> < seed.sql  (or paste into any client).
INSERT INTO users (username, password_hash, created_at) VALUES
  ('demo1', '$2b$10$L97Psg227hls/TrnHCevxug3ihNh8wQxoK9f9a.FyV9LdmWQE3zum', UTC_TIMESTAMP()),
  ('demo2', '$2b$10$qPiH/oltLSmr0QF0Bd/Keu4.vlHrG.IFRjtsGJDIU.bg3xLs4/yqS', UTC_TIMESTAMP());
