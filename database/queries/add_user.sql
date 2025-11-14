WITH vals AS (
  SELECT
    'marcshepard@outlook.com'::text AS email,
    57::int AS pigeon
),
u AS (
  INSERT INTO users (email, password_hash)
  SELECT email, email        -- temporary hash = email
  FROM vals
  -- Important: match your UNIQUE INDEX on (lower(email))
  ON CONFLICT (lower(email)) DO UPDATE
    SET password_hash = EXCLUDED.password_hash
  RETURNING user_id
)
INSERT INTO user_players (user_id, pigeon_number)
SELECT u.user_id, v.pigeon
FROM u
CROSS JOIN vals v
-- your PK (user_id, pigeon_number) will catch duplicates:
ON CONFLICT (user_id, pigeon_number) DO NOTHING;