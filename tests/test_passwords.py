"""Tests for shared password behavior."""

from pathlib import Path

import psycopg

from backend.utils import passwords
from backend.utils.settings import get_settings


def test_provision_password_hash_discards_random_token(monkeypatch):
    token = "independent-high-entropy-provisioning-token"
    requested_bytes: list[int] = []

    def fake_token_urlsafe(byte_count: int) -> str:
        requested_bytes.append(byte_count)
        return token

    monkeypatch.setattr(passwords.secrets, "token_urlsafe", fake_token_urlsafe)

    stored_hash = passwords.provision_password_hash()

    assert requested_bytes == [32]
    assert stored_hash != token
    assert passwords.verify_password(token, stored_hash)


def test_verify_password_rejects_plaintext_and_malformed_values():
    assert not passwords.verify_password("legacy-password", "legacy-password")
    assert not passwords.verify_password("anything", "not-a-bcrypt-hash")


def test_password_repair_sql_is_guarded_and_idempotent():
    repository_root = Path(__file__).resolve().parents[1]
    repair_sql = (repository_root / "scripts" / "repair_non_bcrypt_passwords.sql").read_text(
        encoding="utf-8"
    )
    check_sql = (repository_root / "scripts" / "check_password_hashes.sql").read_text(
        encoding="utf-8"
    )
    target_users = [
        (14, "gray@grayskysolutions.com"),
        (29, "john_cy_ho@hotmail.com"),
        (31, "nealjfowler@gmail.com"),
        (32, "samibroad@yahoo.com"),
        (33, "zayvion36@gmail.com"),
        (5, "davidmoore1987@icloud.com"),
    ]

    settings = get_settings()
    with psycopg.connect(**settings.psycopg_kwargs(), autocommit=True) as conn:
        conn.execute(
            "CREATE TEMP TABLE users (user_id BIGINT PRIMARY KEY, email TEXT, password_hash TEXT)"
        )
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO users (user_id, email, password_hash) VALUES (%s, %s, 'legacy')",
                target_users,
            )

        conn.execute(repair_sql)  # pyright: ignore[reportArgumentType]
        first_hashes = dict(conn.execute("SELECT user_id, password_hash FROM users").fetchall())
        assert len(first_hashes) == 6
        assert all(
            not passwords.verify_password("unrecoverable", value)
            for value in first_hashes.values()
        )
        assert all(value.startswith("$2b$") for value in first_hashes.values())

        conn.execute(repair_sql)  # pyright: ignore[reportArgumentType]
        second_hashes = dict(conn.execute("SELECT user_id, password_hash FROM users").fetchall())
        assert second_hashes == first_hashes

        check_result = conn.execute(check_sql)  # pyright: ignore[reportArgumentType]
        while check_result.nextset():
            pass
        assert check_result.fetchone() == (6, 6, 0)
