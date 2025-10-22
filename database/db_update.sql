-- Script to upgrade the current SQL schema or data

-- Moving from a single players table to a users + players split with N-to-N mapping
-- requires first migrating data from existing players table to users and users_players
-- Then dropping the obsolete columns from players

BEGIN;

-- 1) Create USERS for selected players (hash length > 10)
INSERT INTO users (email, password_hash, is_admin)
SELECT p.email, p.password_hash, COALESCE(p.is_admin, FALSE)
FROM players p
WHERE p.email IS NOT NULL
  AND p.password_hash IS NOT NULL
  AND length(p.password_hash) > 10
  AND NOT EXISTS (
    SELECT 1 FROM users u
    WHERE lower(u.email) = lower(p.email)
  );

-- 2) Create USER↔PIGEON mapping as owner + primary
INSERT INTO user_players (user_id, pigeon_number, role, is_primary)
SELECT u.user_id, p.pigeon_number, 'owner', TRUE
FROM players p
JOIN users u ON lower(u.email) = lower(p.email)
WHERE p.email IS NOT NULL
  AND p.password_hash IS NOT NULL
  AND length(p.password_hash) > 10
ON CONFLICT (user_id, pigeon_number) DO NOTHING;

COMMIT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'players'
      AND column_name = 'email'
  ) THEN
    EXECUTE '
      ALTER TABLE public.players
        DROP COLUMN IF EXISTS email,
        DROP COLUMN IF EXISTS password_hash,
        DROP COLUMN IF EXISTS created_at,
        DROP COLUMN IF EXISTS is_admin,
        DROP COLUMN IF EXISTS secondary_emails
    ';
  END IF;
END
$$;