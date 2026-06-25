-- Stage 10 migration: player season status + configurable tenant payouts
-- Run against pigeon_pool_multi ONLY (never against pigeon_pool).
-- Command: psql -U postgres -d pigeon_pool_multi -f database/migration_stage10.sql

BEGIN;

-- Track each pigeon's participation state for the coming season.
-- Resets to 'pending' every season via the reset-season CLI command.
ALTER TABLE players
  ADD COLUMN season_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (season_status IN ('pending', 'active', 'out'));

-- Per-tenant configurable payout amounts per finishing place.
CREATE TABLE tenant_payouts (
  tenant_id BIGINT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  place     INT    NOT NULL CHECK (place >= 1),
  points    INT    NOT NULL CHECK (points >= 0),
  PRIMARY KEY (tenant_id, place)
);

-- Seed tenant 1 with the original payout amounts.
INSERT INTO tenant_payouts (tenant_id, place, points)
VALUES
  (1, 1, 530),
  (1, 2, 270),
  (1, 3, 160),
  (1, 4, 100),
  (1, 5,  70);

COMMIT;
