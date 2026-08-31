"""Configuration checks for the Alembic migration environment."""

from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

_REPO_ROOT = Path(__file__).resolve().parents[1]
_CONFIG_PATH = _REPO_ROOT / "backend" / "alembic.ini"


def test_alembic_configuration_resolves_directory_and_has_exactly_one_head():
    config = Config(str(_CONFIG_PATH))
    scripts = ScriptDirectory.from_config(config)

    assert Path(scripts.dir).resolve() == (_REPO_ROOT / "backend" / "migrations").resolve()
    assert len(scripts.get_heads()) == 1


def test_alembic_configuration_contains_no_database_credentials():
    config_text = _CONFIG_PATH.read_text(encoding="utf-8")

    assert "sqlalchemy.url" not in config_text
    assert "POSTGRES_PASSWORD" not in config_text
