-- Seed a second tenant for local multi-tenant testing.
-- Edit YOUR_EMAIL below before running.
-- Run: psql -U postgres -d pigeon_pool -f database/seed_test_tenant.sql
--
-- After running:
--   1. Log in with YOUR_EMAIL at the frontend.
--   2. POST /auth/select-context {"tenant_id": <new id>} to switch tenants.
--   3. Use the admin UI to add pigeons and assign users within the new tenant.

BEGIN;

-- 1. Create the tenant
INSERT INTO tenants (name) VALUES ('Marc''s Test Pool')
RETURNING tenant_id;  -- note: tenant_id for reference; use \gset or capture in psql

-- 2. Capture the new tenant_id for use in subsequent statements
-- (psql \gset trick: run this file with psql so \gset works)
-- If running programmatically, replace :new_tenant_id with the actual value.

DO $$
DECLARE
    v_tenant_id   BIGINT;
    v_user_id     BIGINT;
    v_player_id   BIGINT;
    v_commissioner_email TEXT := 'marcshepard@outlook.com';  -- << EDIT THIS
BEGIN
    -- Get the tenant we just inserted (most recent)
    SELECT tenant_id INTO v_tenant_id FROM tenants ORDER BY tenant_id DESC LIMIT 1;

    -- Copy default lock times into this tenant's schedule
    INSERT INTO tenant_weeks (tenant_id, week_number, lock_at)
    SELECT v_tenant_id, week_number, default_lock_at
      FROM weeks
     WHERE default_lock_at IS NOT NULL
    ON CONFLICT DO NOTHING;

    RAISE NOTICE 'Created tenant_id=% with % week locks',
        v_tenant_id,
        (SELECT COUNT(*) FROM tenant_weeks WHERE tenant_id = v_tenant_id);

    -- Look up the commissioner user
    SELECT user_id INTO v_user_id FROM users WHERE lower(email) = lower(v_commissioner_email);
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'User % not found. Create the user first or check the email.', v_commissioner_email;
    END IF;

    -- Create a placeholder player for the commissioner in the new tenant
    -- (pigeon_number=1; rename via admin UI after login)
    INSERT INTO players (tenant_id, pigeon_number, pigeon_name)
    VALUES (v_tenant_id, 1, 'Commissioner')
    RETURNING player_id INTO v_player_id;

    -- Assign the user as owner of that player
    INSERT INTO user_players (user_id, player_id, role)
    VALUES (v_user_id, v_player_id, 'owner')
    ON CONFLICT DO NOTHING;

    -- Add to tenant_members as commissioner
    INSERT INTO tenant_members (tenant_id, user_id, role, primary_player_id)
    VALUES (v_tenant_id, v_user_id, 'commissioner', v_player_id)
    ON CONFLICT (tenant_id, user_id) DO UPDATE
        SET role = 'commissioner', primary_player_id = EXCLUDED.primary_player_id;

    RAISE NOTICE 'User % (user_id=%) added as commissioner of tenant_id=%',
        v_commissioner_email, v_user_id, v_tenant_id;
END;
$$;

COMMIT;
