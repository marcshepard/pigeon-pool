-- Read-only inventory. This never returns a stored password or password hash.
SELECT
    user_id,
    email,
    CASE
        WHEN password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
            THEN 'bcrypt - unaffected'
        WHEN password_hash ~ '^tmp[0-9]+$'
            THEN 'old temporary password'
        WHEN length(password_hash) = 16
            THEN 'possible old generated plaintext placeholder'
        ELSE
            'other unrecognized/plaintext value'
    END AS password_state
FROM users
ORDER BY password_state, email;

SELECT
    count(*) AS total_users,
    count(*) FILTER (
        WHERE password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
    ) AS bcrypt_users,
    count(*) FILTER (
        WHERE password_hash !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
    ) AS non_bcrypt_users
FROM users;
