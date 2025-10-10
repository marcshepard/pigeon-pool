/*
Imbues picks for a couple of players for testing purposes.
*/

-- Temporarily disable lock triggers (insert/update) on picks
ALTER TABLE picks DISABLE TRIGGER trg_picks_insert_lock;
ALTER TABLE picks DISABLE TRIGGER trg_picks_update_lock;

-- Upsert: make/overwrite picks for all games in weeks 1..6
INSERT INTO picks (pigeon_number, game_id, picked_home, predicted_margin)
SELECT
  57                AS pigeon_number,
  g.game_id         AS game_id,
  TRUE              AS picked_home,        -- home team
  3                 AS predicted_margin    -- margin 3
FROM games g
WHERE g.week_number BETWEEN 1 AND 6
ON CONFLICT (pigeon_number, game_id)
DO UPDATE SET
  picked_home      = EXCLUDED.picked_home,
  predicted_margin = EXCLUDED.predicted_margin,
  created_at       = now();

-- Re-enable triggers
ALTER TABLE picks ENABLE TRIGGER trg_picks_insert_lock;
ALTER TABLE picks ENABLE TRIGGER trg_picks_update_lock;

COMMIT;