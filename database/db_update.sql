CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_single_primary
  ON user_players(user_id)
  WHERE is_primary = TRUE;

DROP INDEX IF EXISTS uniq_pigeon_single_primary;