-- Stage 5 migration: add last_used_at to tenant_members
-- Run against pigeon_pool_multi (never against pigeon_pool).
-- psql -U postgres -d pigeon_pool_multi -f database/migration_stage5.sql

BEGIN;

ALTER TABLE tenant_members
    ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

COMMIT;
