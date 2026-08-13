-- Add the per-league switch that controls whether members may enter picks.
-- Existing leagues remain open by default. Idempotent so the script is safe
-- to run against both local development and production databases.

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS picks_open BOOLEAN NOT NULL DEFAULT true;
