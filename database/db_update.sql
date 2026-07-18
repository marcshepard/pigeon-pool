-- =============================================================
-- DB update scripts go here
-- =============================================================

-- Let a commissioner opt out of self-service pigeon renaming (on by default).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pigeons_can_rename BOOLEAN NOT NULL DEFAULT true;

