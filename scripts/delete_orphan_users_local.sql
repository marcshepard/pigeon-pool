-- Delete global users with no league membership or pigeon assignment.
-- Safety: this script refuses to run against a non-loopback PostgreSQL server.
-- Run scripts/find_orphan_users.sql first and review every row.

BEGIN;

DO $local_database_check$
DECLARE
    server_address inet := inet_server_addr();
BEGIN
    IF server_address IS NOT NULL
       AND NOT (
           server_address <<= inet '127.0.0.0/8'
           OR server_address = inet '::1'
       ) THEN
        RAISE EXCEPTION
            'Deletion stopped: PostgreSQL server address % is not loopback',
            server_address;
    END IF;
END
$local_database_check$;

-- Keep the orphan snapshot stable until deletion completes.
LOCK TABLE users, tenant_members, user_players IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE orphan_users_to_delete ON COMMIT DROP AS
SELECT users.user_id, users.email
FROM users
WHERE NOT EXISTS (
          SELECT 1
          FROM tenant_members
          WHERE tenant_members.user_id = users.user_id
      )
  AND NOT EXISTS (
          SELECT 1
          FROM user_players
          WHERE user_players.user_id = users.user_id
      );

-- Preview captured by this transaction.
SELECT user_id, email
FROM orphan_users_to_delete
ORDER BY lower(email), user_id;

-- The NOT EXISTS checks are deliberately repeated at deletion time.
DELETE FROM users
USING orphan_users_to_delete
WHERE users.user_id = orphan_users_to_delete.user_id
  AND NOT EXISTS (
          SELECT 1
          FROM tenant_members
          WHERE tenant_members.user_id = users.user_id
      )
  AND NOT EXISTS (
          SELECT 1
          FROM user_players
          WHERE user_players.user_id = users.user_id
      )
RETURNING users.user_id, users.email;

COMMIT;

-- Expected result after cleanup: zero.
SELECT count(*) AS remaining_orphan_users
FROM users
WHERE NOT EXISTS (
          SELECT 1
          FROM tenant_members
          WHERE tenant_members.user_id = users.user_id
      )
  AND NOT EXISTS (
          SELECT 1
          FROM user_players
          WHERE user_players.user_id = users.user_id
      );
