-- One-time production repair for the six accounts inventoried on 2026-08-31.
-- Each replacement is a bcrypt hash of a separate discarded random token.
-- The script is idempotent: a password already reset to bcrypt is not overwritten.

BEGIN;

CREATE TEMP TABLE password_hash_repairs (
    user_id BIGINT PRIMARY KEY,
    email TEXT NOT NULL,
    replacement_hash TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO password_hash_repairs (user_id, email, replacement_hash) VALUES
    (14, 'gray@grayskysolutions.com', '$2b$12$jM.BKmgr8SPXnju7OICeYOTSLEmykij..rePgm23E6Vsinhqa/nHm'),
    (29, 'john_cy_ho@hotmail.com', '$2b$12$rl/rxDaDmqds3qsDnU0HmO1GMykA0ZnG/Y6DI.4DKZYND9JqwKcuS'),
    (31, 'nealjfowler@gmail.com', '$2b$12$iBuIataLJuqrtxw2.vdVG.kz1t9lmPkbZ0EPALQdeHpGnCf8x3YeS'),
    (32, 'samibroad@yahoo.com', '$2b$12$eCNeYbgscKzn/KHU9o9vLuU/z0xg9PE5v/7eETLboGeBVHs5I.5N2'),
    (33, 'zayvion36@gmail.com', '$2b$12$sDJz13O2rAJPJEZCFy39.O4B7SuC7c1s0RI3We9orv.PZvTmamcTK'),
    (5, 'davidmoore1987@icloud.com', '$2b$12$kzrSRHSIC0na6eaNdZFCK.TnvkePb2nDjrsYaXLvTjuQ4buSeMh/G');

DO $repair_identity_check$
BEGIN
    IF (
        SELECT count(*)
        FROM password_hash_repairs repairs
        JOIN users
          ON users.user_id = repairs.user_id
         AND lower(users.email) = lower(repairs.email)
    ) <> 6 THEN
        RAISE EXCEPTION 'Repair stopped: expected six exact user ID/email matches';
    END IF;
END
$repair_identity_check$;

UPDATE users
SET password_hash = repairs.replacement_hash
FROM password_hash_repairs repairs
WHERE users.user_id = repairs.user_id
  AND lower(users.email) = lower(repairs.email)
  AND users.password_hash !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$';

DO $repair_result_check$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM password_hash_repairs repairs
        JOIN users
          ON users.user_id = repairs.user_id
         AND lower(users.email) = lower(repairs.email)
        WHERE users.password_hash !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
    ) THEN
        RAISE EXCEPTION 'Repair stopped: at least one target is still not bcrypt';
    END IF;
END
$repair_result_check$;

COMMIT;

-- Expected result: six rows, all "bcrypt - ready for password reset".
SELECT
    users.user_id,
    users.email,
    'bcrypt - ready for password reset' AS password_state
FROM users
JOIN (
    VALUES
        (14, 'gray@grayskysolutions.com'),
        (29, 'john_cy_ho@hotmail.com'),
        (31, 'nealjfowler@gmail.com'),
        (32, 'samibroad@yahoo.com'),
        (33, 'zayvion36@gmail.com'),
        (5, 'davidmoore1987@icloud.com')
) AS repaired(user_id, email)
  ON users.user_id = repaired.user_id
 AND lower(users.email) = lower(repaired.email)
WHERE users.password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
ORDER BY users.user_id;
