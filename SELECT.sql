SELECT
    user_id,
    email,
    CASE
        WHEN password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
            THEN 'bcrypt — unaffected'
        WHEN password_hash ~ '^tmp[0-9]+$'
            THEN 'old temporary password'
        WHEN length(password_hash) = 16
            THEN 'likely admin-generated placeholder'
        ELSE
            'other unrecognized/plaintext value'
    END AS password_state
FROM users
ORDER BY password_state, email;