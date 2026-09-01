-- Read-only inventory of global users with no league membership or pigeon assignment.
-- These users are not visible in the league-manager roster UI.
SELECT
    users.user_id,
    users.email
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
      )
ORDER BY lower(users.email), users.user_id;
