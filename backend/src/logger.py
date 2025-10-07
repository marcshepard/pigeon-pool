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
import inspect
import traceback
from typing import Any, Dict, Optional

#pylint: disable=line-too-long

# Log levels as strings
LOG_LEVELS = ("debug", "info", "warn", "error")

# Config from env
_LOG_LEVEL = os.getenv("LOGGING_LEVEL", "info").lower()
if _LOG_LEVEL not in LOG_LEVELS:
    _LOG_LEVEL = "debug"
_LOG_COLOR = os.getenv("LOG_COLOR", "true").lower() == "true" and sys.stdout.isatty()

# Colors (optional, dev-only)
_COL = {
    "debug": "\033[36m",   # cyan
    "info":  "\033[32m",   # green
    "warn":  "\033[33m",   # yellow
    "error": "\033[31m",   # red
    "end": "\033[0m",
}

def set_level(level_name: str) -> None:
    """Set global log level. E.g. 'debug', 'info', 'warn', 'error'"""
    global _LOG_LEVEL # pylint: disable=global-statement
    level = level_name.lower()
    if level not in LOG_LEVELS:
        error(f"Invalid log level: {level_name}")
        return
    global _LOG_LEVEL # pylint: disable=global-statement
    _LOG_LEVEL = level
    info (f"Log level set to: {_LOG_LEVEL}")

def _where() -> str:
    # Find the first frame outside logger.py
    for frame in inspect.stack()[2:]:
        fname = os.path.basename(frame.filename)
        if fname != os.path.basename(__file__):
            return f"{fname}:{frame.lineno}"
    return "?:?"

def _sink(level: int):
    # WARN/ERROR → stderr, else stdout
    return sys.stderr if level in ("warn", "error") else sys.stdout

def _lvl_name(level: int) -> str:
    return level.upper() if level in LOG_LEVELS else str(level)

def _fmt_kvs(kvs: Optional[Dict[str, Any]]) -> str:
    if not kvs:
        return ""
    parts = []
    for k, v in kvs.items():
        try:
            parts.append(f"{k}={v}")
        except (TypeError, ValueError):
            parts.append(f"{k}=<unrepr>")
    return " " + " ".join(parts)

def log(level: int, msg: str, **kvs: Any) -> None:
    """Core logging function. Use debug/info/warn/error helpers."""
    # Only log if level is >= current log level
    if LOG_LEVELS.index(level) < LOG_LEVELS.index(_LOG_LEVEL):
        return
    loc = _where()
    lvl = _lvl_name(level)
    line = f"{lvl} ({loc}): {msg}{_fmt_kvs(kvs)}"
    if _LOG_COLOR:
        c = _COL.get(level, "")
        e = _COL["end"]
        line = f"{c}{line}{e}"
    print(line, file=_sink(level), flush=True)

def debug(msg: str, **kvs: Any) -> None:
    """ Log a debug-level message """
    if _LOG_LEVEL != "debug":
        print("SKIPPED DEBUG LOG")
        return
    log("debug", msg, **kvs)

def info(msg: str,  **kvs: Any) -> None:
    """ Log an info-level message """
    log("info",  msg, **kvs)

def warn(msg: str,  **kvs: Any) -> None:
    """ Log a warning-level message """
    log("warn",  msg, **kvs)

def error(msg: str, **kvs: Any) -> None:
    """ Log an error-level message """
    log("error", msg, **kvs)

def log_exception(msg: str, *, level: str = "error", exc: BaseException | None = None, **kvs: Any) -> None:
    """
    Logs a message plus a compact traceback, without swallowing the exception.
    Intended for 'observe then re-raise' scenarios.
    """
    exc = exc or sys.exc_info()[1]
    if exc is None:
        # nothing to attach, just log
        log(level, msg, **kvs)
        return
    # Add the exception type/message
    kvs = {**kvs, "exc": f"{exc.__class__.__name__}: {exc}"}
    log(level, msg, **kvs)
    tb = "".join(traceback.format_tb(exc.__traceback__)) if exc.__traceback__ else ""
    if tb:
        for line in tb.rstrip().splitlines():
            log(level, f" └ {line}")
