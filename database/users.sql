-- Script to populate the users table

INSERT INTO players (pigeon_number, pigeon_name, email, password_hash, is_admin)
VALUES
  (14, 'k.d.''s dad', 'pigeonfootballpool@gmail.com', 'tmp14', TRUE),
  (47, 'JoswkiHawk', 'joewelch@msn.com', 'tmp47', TRUE),
  (57, 'SeaSaw', 'marcshepard@outlook.com', 'tmp57', TRUE)
ON CONFLICT (pigeon_number) DO NOTHING;