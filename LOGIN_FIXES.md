# Login security follow-up

This file tracks the high-priority authentication work intentionally deferred from the
multi-tenancy isolation fixes. These items should be handled together because several require a
coordinated database, backend, and frontend migration.

## Schema and backend summary

| Stage | Required schema change | Required backend/API change |
|------|-------------------------|-----------------------------|
| 1. Rate limiting | None by default | Add per-IP and normalized-account throttles to login and reset requests; return `429` with generic behavior. |
| 2. Password hardening | None; `users.password_hash TEXT NOT NULL` is sufficient | Remove plaintext comparison, enforce the password policy, use an unusable marker for new accounts, and add a legacy-hash inventory command. |
| 3. Session invalidation | Add `users.session_version INTEGER NOT NULL DEFAULT 0`; no index is needed | Put the version in session JWTs, compare it in `current_user`, and increment it after password reset or sign-out-everywhere. |
| 4. Atomic reset use | Make `password_reset_uses` a required Alembic-managed table | Atomically claim the reset JTI in the password-update transaction and remove request-time DDL. |
| 5. HttpOnly cookie and CSRF | None for a stateless signed-cookie design | Set/read/clear the session cookie, require CSRF proof on mutations, update CORS/cookie settings, and retire bearer-token responses after transition. |

The session-version column and reset-use table can ship together in one additive revision, using
the next available revision number. If the Alembic canary consumes `0002`, this work starts at
`0003`; revision numbers are chronological identifiers, not fixed feature names.

## 1. Rate-limit authentication and password-reset endpoints

`POST /auth/login` and `POST /auth/password-reset` currently have no attempt throttling. This
allows password guessing and reset-email flooding. Add per-IP and per-account limits, with a
short burst allowance and a longer cooldown. Enforce the primary limit at the public edge when
possible and retain an application-level limit so alternate deployment paths are also protected.

Keep login and reset responses generic. Avoid logging secrets or full reset URLs, and make the
unknown-account reset path comparable in timing to the known-account path.

**Schema/Alembic:** No PostgreSQL schema change is required for the initial implementation. Apply
the normalized-account limiter even when the email does not exist so its behavior does not reveal
registered accounts. The current single-instance App Service can use a bounded in-process limiter
as defense in depth, but any future multi-instance deployment needs shared edge or cache-backed
state. Do not introduce an authentication-attempt table by default: it would add retention/privacy
work and make the primary database part of the abuse path.

**Backend/API:** Make the login and reset-request handlers accept request context, derive the
client IP only from Azure's trusted proxy path, and apply both per-IP and normalized-email limits.
Define short-burst and longer-window thresholds in configuration. A rejected request returns
`429 Too Many Requests` and a useful `Retry-After`, without revealing whether the email exists.
Keep `POST /auth/password-reset` returning the same success body for known and unknown accounts,
make their timing reasonably comparable, and never log passwords, tokens, or full reset URLs.
Add focused tests for each limiter, window expiry, generic responses, and trusted-proxy handling.

## 2. Require hashed passwords and enforce a password policy

Login currently accepts any non-bcrypt `users.password_hash` value as a plaintext password.
Before removing that compatibility path:

1. Inventory production rows whose value is not a recognized bcrypt hash.
2. Force password reset for any real legacy account in that set.
3. Give newly provisioned users an explicitly unusable password marker rather than a random
   plaintext placeholder.
4. Remove plaintext comparison from login and accept only supported password hashes.

Password reset should validate a reasonable passphrase policy (recommended: 12–128 characters)
on both the backend model and frontend form. Do not impose composition rules that discourage
password managers or long passphrases.

**Schema/Alembic:** No migration is required. The existing `users.password_hash TEXT NOT NULL`
column can store supported hashes and an explicit unusable marker. Do not add a bcrypt-specific
database constraint: it would complicate future algorithm upgrades and the unusable marker.

**Backend/API:** Add one shared password-policy validator, initially 12–128 characters, and apply
it to `PasswordResetConfirmIn`; keep the frontend validation identical. Bound login password input
as well so deliberately huge values cannot waste hashing resources. Replace the current
`payload.password == stored_hash` fallback with supported-hash verification only. Add a read-only
CLI inventory for unrecognized values, update every user-creation path to store the unusable
marker, and require password reset before those users can log in. Preserve generic login failures
and add tests for legacy plaintext rejection, supported hashes, the marker, and length boundaries.

## 3. Invalidate sessions after security-sensitive account changes

Session JWTs are self-contained and remain valid until expiry. Resetting a password therefore
does not revoke a previously stolen token, and the backend logout endpoint cannot invalidate a
copied token.

Add a server-checked session generation/version to `users`, include it in each session token, and
compare it in `current_user`. Increment it after password reset and when the user chooses a
"sign out everywhere" action. If individual-session logout is required, add a session table or
JWT ID allow/deny mechanism instead of using a single account-wide generation.

**Schema/Alembic:** Add `users.session_version INTEGER NOT NULL DEFAULT 0`. This is an additive,
metadata-only change for existing rows on supported PostgreSQL versions and does not need an index,
because authentication already finds the user by primary key. Preserve the default so new users
start at version zero. The revision test must verify existing users remain intact and receive zero.
Because this is the first post-baseline column, update the schema verification/tests so they verify
the current Alembic head rather than rejecting the intentional addition as baseline drift.

**Backend/API:** Add an integer `sv` claim to every session JWT issued by login, password-reset
confirmation, and tenant switching. `current_user` must select the current database version and
reject a token whose claim is missing or different. Increment `session_version` in the same
transaction as a password change, then issue the replacement token using the returned new value.
Add an authenticated `POST /auth/logout-all` (or explicitly redefine the existing endpoint) that
increments the version. Ordinary bearer-token logout remains client-side until the cookie stage;
do not claim that it revokes copied tokens. Test that old tokens fail after reset/sign-out-everywhere
and that tenant switching preserves the current version.

## 4. Consume password-reset tokens atomically

Reset confirmation currently checks whether a JWT ID was used and records it later. Concurrent
requests can both pass the initial check. Move `password_reset_uses` into the normal schema and
claim the JWT ID atomically with `INSERT ... ON CONFLICT DO NOTHING RETURNING`. Continue only when
that statement returns a row, in the same transaction as the password update and session-version
increment.

**Schema/Alembic:** Adopt this exact table as required schema:

```sql
CREATE TABLE password_reset_uses (
  jti TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The migration must support both known starting states: create the table when absent; when present,
verify its columns, primary key, default, and cascading foreign key and preserve every row. No
additional index is required for the JTI claim. After adoption, update the schema verifier so the
table is required at head rather than optional, and test both starting states.

**Backend/API:** Delete `ensure_reset_table()`, `jti_already_used()`, and `mark_jti_used()`.
After validating the signed reset token and resolving its user, claim it with
`INSERT ... ON CONFLICT DO NOTHING RETURNING jti`. Continue only when a row is returned. Keep that
claim, the bcrypt password update, the `session_version` increment, tenant-context lookup, and
`last_used_at` update in one transaction; any later failure rolls the claim back so a legitimate
retry remains possible. A conflict returns the existing generic invalid/used-token response. Add a
concurrency test proving two confirmations cannot both succeed and a rollback/retry test.

## 5. Protect browser session tokens from script access

The frontend stores the bearer JWT in `localStorage`, so any successful same-origin script
injection can steal it. Prefer an `HttpOnly`, `Secure`, appropriately `SameSite` session cookie.
That migration must include explicit CSRF protection for mutating requests and a review of CORS
and cookie lifetime behavior.

Until that migration is complete, deploy a strict Content Security Policy, avoid third-party
scripts, keep session lifetimes short, and ensure authentication tokens are never written to
logs or error-reporting payloads.

**Schema/Alembic:** No schema change is required for the recommended stateless session JWT plus
CSRF-token design. A server-side `sessions` table is a separate future choice only if the product
needs individual-session listing/revocation; it is not needed for account-wide invalidation.

**Backend/API:** During a short compatibility release, allow the auth dependency to read either the
existing bearer header or the new cookie, while issuing the cookie from login, reset confirmation,
and tenant switching. Then remove `access_token` from response bodies and retire bearer-header
acceptance. Use a host-only `HttpOnly`, `Secure`, appropriately `SameSite` cookie with explicit
path, maximum age, and deletion behavior. `POST /auth/logout` must clear it even if the session is
expired. Issue a separate script-readable CSRF token (or equivalent signed token), require it in a
custom header on every state-changing request—including authentication endpoints where applicable—
and compare it safely. Prefer the existing same-origin `/api` frontend proxy; for any direct
cross-origin calls, allow only the configured origins, enable credentials, and never use a wildcard.
Add browser/API tests for cookie flags, missing/incorrect CSRF rejection, login, logout, reset,
tenant switching, expiry, and cross-origin rejection.

## Suggested implementation order

1. Rate limits and reset-email abuse protection. No database migration.
2. Password inventory, password policy, and removal of plaintext compatibility. No database
   migration.
3. Add the session-version column and adopt the reset-use table in an additive Alembic revision;
   then deploy atomic reset consumption and session-version invalidation.
4. Migrate to HttpOnly cookies and CSRF protection. No database migration unless individual
   server-side sessions are deliberately added to scope.

Each change should include focused backend tests. The cookie migration also needs browser tests
covering login, logout, password reset, tenant switching, expiry, and cross-origin rejection.
