"""Shared password hashing, verification, and policy constants."""

import secrets

from passlib.hash import bcrypt  # pyright: ignore[reportAttributeAccessIssue]

PASSWORD_MIN_LENGTH = 8
PASSWORD_MAX_LENGTH = 128
_PROVISIONED_PASSWORD_BYTES = 32


def hash_password(password: str) -> str:
    """Return a bcrypt hash for a user-selected password."""
    return bcrypt.hash(password)


def provision_password_hash() -> str:
    """Return a bcrypt hash whose high-entropy source password is immediately discarded."""
    return hash_password(secrets.token_urlsafe(_PROVISIONED_PASSWORD_BYTES))


def verify_password(password: str, stored_hash: str) -> bool:
    """Verify a bcrypt password, rejecting plaintext and malformed stored values."""
    try:
        return bcrypt.verify(password, stored_hash)
    except (TypeError, ValueError):
        return False
