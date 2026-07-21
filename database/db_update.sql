-- =============================================================
-- DB update scripts go here
-- =============================================================

-- Let a commissioner opt out of self-service pigeon renaming (on by default).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pigeons_can_rename BOOLEAN NOT NULL DEFAULT true;

-- Runtime roster/auth columns that were present in deployed databases but
-- missing from the canonical schema file.
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS season_status TEXT NOT NULL DEFAULT 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'players'::regclass
       AND conname = 'players_season_status_check'
  ) THEN
    ALTER TABLE players
      ADD CONSTRAINT players_season_status_check
      CHECK (season_status IN ('pending','active','out')) NOT VALID;
  END IF;
END $$;

ALTER TABLE players VALIDATE CONSTRAINT players_season_status_check;

ALTER TABLE tenant_members
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS tenant_payouts (
  tenant_id BIGINT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  place     INT    NOT NULL CHECK (place >= 1),
  points    INT    NOT NULL CHECK (points >= 0),
  PRIMARY KEY (tenant_id, place)
);

