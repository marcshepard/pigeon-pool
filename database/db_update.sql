-- Private commissioner notes attached to roster entries.
ALTER TABLE players
    ADD COLUMN IF NOT EXISTS commissioner_notes TEXT NOT NULL DEFAULT '';
