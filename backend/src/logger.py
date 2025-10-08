"""
Simple, human-friendly logger for Pigeon Pool

Output format: LEVEL (file:line): message [k=v ...]

Key methods:
* set_level(level_name: str) - set global log level
* debug/info/warn/error(msg: str, **kvs) - log at various levels
* log_exception(msg: str, level=ERROR, exc=None, **kvs) - log message + traceback
  (for 'observe then re-raise' scenarios)
"""

from __future__ import annotations
import os
import sys

#pylint: disable=line-too-long, missing-function-docstring

LOG_LEVELS = ("debug", "info", "warn", "error")
_LOG_LEVEL = "info"  # default until configured

def configure_from_env():
    """Call once at startup (after env loaded) to set level."""
    global _LOG_LEVEL #pylint: disable=global-statement
    lvl = os.getenv("LOGGING_LEVEL", "info").lower()
    _LOG_LEVEL = lvl if lvl in LOG_LEVELS else "info"

def set_level(level: str):
    global _LOG_LEVEL #pylint: disable=global-statement
    level = level.lower()
    if level in LOG_LEVELS:
        _LOG_LEVEL = level

def debug(msg, **kw):
    if _LOG_LEVEL == "debug":
        print(msg, kw, file=sys.stderr)

def info(msg, **kw):
    if _LOG_LEVEL in ("debug", "info"):
        print(msg, kw, file=sys.stderr)

def warn(msg, **kw):
    if _LOG_LEVEL in ("debug", "info", "warn"):
        print(msg, kw, file=sys.stderr)

def error(msg, **kw):
    print(msg, kw, file=sys.stderr)
