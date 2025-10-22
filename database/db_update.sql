
-- Give user with email 'davegryson@gmail.com' 'manager' permission to pigeon 37
INSERT INTO user_players (user_id, pigeon_number, role, is_primary)
SELECT user_id, 1, 'manager', FALSE FROM users WHERE lower(email) = 'marcshepard@outlook.com';

