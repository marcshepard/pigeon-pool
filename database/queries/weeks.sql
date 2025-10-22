
SELECT week_number, lock_at
    FROM weeks
    WHERE lock_at < now()
    ORDER BY lock_at DESC
    LIMIT 1;

SELECT week_number
    FROM weeks
    WHERE lock_at < now()
    ORDER BY lock_at DESC
    LIMIT 1

/* 10/21 midnight PST (yesterday)
    SELECT
        week_number,
        to_char(lock_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI:SS') || ' PST' AS lock_at_pst
    FROM weeks
    WHERE week_number = 8;
*/
