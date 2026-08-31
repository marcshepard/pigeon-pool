# Login security follow-up

This file tracks the high-priority authentication work intentionally deferred from the
multi-tenancy isolation fixes. These items should be handled together because several require a
coordinated database, backend, and frontend migration.

## 1. Rate-limit authentication and password-reset endpoints

`POST /auth/login` and `POST /auth/password-reset` currently have no attempt throttling. This
allows password guessing and reset-email flooding. Add per-IP and per-account limits, with a
short burst allowance and a longer cooldown. Enforce the primary limit at the public edge when
possible and retain an application-level limit so alternate deployment paths are also protected.

Keep login and reset responses generic. Avoid logging secrets or full reset URLs, and make the
unknown-account reset path comparable in timing to the known-account path.

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

## 3. Invalidate sessions after security-sensitive account changes

Session JWTs are self-contained and remain valid until expiry. Resetting a password therefore
does not revoke a previously stolen token, and the backend logout endpoint cannot invalidate a
copied token.

Add a server-checked session generation/version to `users`, include it in each session token, and
compare it in `current_user`. Increment it after password reset and when the user chooses a
"sign out everywhere" action. If individual-session logout is required, add a session table or
JWT ID allow/deny mechanism instead of using a single account-wide generation.

## 4. Consume password-reset tokens atomically

Reset confirmation currently checks whether a JWT ID was used and records it later. Concurrent
requests can both pass the initial check. Move `password_reset_uses` into the normal schema and
claim the JWT ID atomically with `INSERT ... ON CONFLICT DO NOTHING RETURNING`. Continue only when
that statement returns a row, in the same transaction as the password update and session-version
increment.

## 5. Protect browser session tokens from script access

The frontend stores the bearer JWT in `localStorage`, so any successful same-origin script
injection can steal it. Prefer an `HttpOnly`, `Secure`, appropriately `SameSite` session cookie.
That migration must include explicit CSRF protection for mutating requests and a review of CORS
and cookie lifetime behavior.

Until that migration is complete, deploy a strict Content Security Policy, avoid third-party
scripts, keep session lifetimes short, and ensure authentication tokens are never written to
logs or error-reporting payloads.

## Suggested implementation order

1. Rate limits and reset-email abuse protection.
2. Password inventory, password policy, and removal of plaintext compatibility.
3. Atomic reset-token consumption plus session-version invalidation.
4. HttpOnly-cookie migration and CSRF protection.

Each change should include focused backend tests. The cookie migration also needs browser tests
covering login, logout, password reset, tenant switching, expiry, and cross-origin rejection.
