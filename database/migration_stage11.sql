-- Stage 11 migration: add ON DELETE CASCADE to players.tenant_id
-- Deleting a tenant now automatically deletes its players (and cascades further to picks
-- via the existing picks.player_id CASCADE, and user_players via user_players.player_id CASCADE).
-- Users (logins) are NOT affected — they span tenants and are managed separately.
-- Run against pigeon_pool_multi ONLY (never against pigeon_pool).
-- Command: psql -U postgres -d pigeon_pool_multi -f database/migration_stage11.sql

BEGIN;

ALTER TABLE players
  DROP CONSTRAINT players_tenant_id_fkey,
  ADD CONSTRAINT players_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE;

COMMIT;
