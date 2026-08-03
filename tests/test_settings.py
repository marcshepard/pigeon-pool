"""Focused tests for environment setting parsing."""

import pytest

from backend.utils.settings import _parse_frontend_origins


def test_parse_frontend_origins_accepts_bracketed_comma_separated_values():
    assert _parse_frontend_origins("[http://localhost:5173, https://pigeonpool.com]") == [
        "http://localhost:5173",
        "https://pigeonpool.com",
    ]


def test_parse_frontend_origins_accepts_one_unbracketed_value():
    assert _parse_frontend_origins("http://localhost:5173") == ["http://localhost:5173"]


def test_parse_frontend_origins_rejects_an_empty_list():
    with pytest.raises(RuntimeError, match="at least one origin"):
        _parse_frontend_origins("[]")
