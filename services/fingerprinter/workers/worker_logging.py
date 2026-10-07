"""Structured logs: one JSON object per line on standard output, which the platform captures.

Every line has a timestamp, a level and a message; lines written while a job runs carry its request id
(bound with structlog's context variables); error lines carry the stack trace. Audio, clips and
download addresses are removed whatever key they arrive under, long values are cut short (a stack
trace keeps its start and its end, where the error itself is named), and uncaught errors (in the main
thread or in an asyncio task) are logged the same way.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from typing import Any, TextIO

import structlog

# Values that must never reach a log line, by the key they would be logged under.
REMOVED_KEYS = frozenset({"audio", "audio_base64", "clip", "samples", "download_address", "file_bytes"})
MAXIMUM_VALUE_CHARACTERS = 4_000


def _remove_forbidden_values(_logger: Any, _method: str, event: dict[str, Any]) -> dict[str, Any]:
    for key in REMOVED_KEYS.intersection(event):
        event[key] = "[removed]"
    return event


def _shorten_long_values(_logger: Any, _method: str, event: dict[str, Any]) -> dict[str, Any]:
    for key, value in event.items():
        if isinstance(value, (bytes, bytearray)):
            event[key] = f"[{len(value)} bytes]"
        elif isinstance(value, str) and len(value) > MAXIMUM_VALUE_CHARACTERS and key == "exception":
            # The last lines of a stack trace name the error and where it happened: never cut those off.
            event[key] = value[:MAXIMUM_VALUE_CHARACTERS // 4] + "\n…\n" + value[-(MAXIMUM_VALUE_CHARACTERS * 3 // 4):]
        elif isinstance(value, str) and len(value) > MAXIMUM_VALUE_CHARACTERS:
            event[key] = value[:MAXIMUM_VALUE_CHARACTERS] + "…"
    return event


def configure_logging(level: str = "INFO", stream: TextIO | None = None) -> None:
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True, key="timestamp"),
            _remove_forbidden_values,
            structlog.processors.format_exc_info,         # exc_info → "exception": the stack trace as text
            _shorten_long_values,
            structlog.processors.EventRenamer("message"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelNamesMapping()[level]),
        logger_factory=structlog.PrintLoggerFactory(stream if stream is not None else sys.stdout),
        cache_logger_on_first_use=False,
    )


def get_logger(**bound: Any) -> structlog.typing.FilteringBoundLogger:
    return structlog.get_logger(**bound)


def install_crash_handlers(loop: asyncio.AbstractEventLoop) -> None:
    """Uncaught exceptions anywhere become one structured line with the stack, never a bare traceback.

    Since Python 3.12 the loop calls its exception handler inside the failed task's own context, so a
    failed task's line carries the request id and job id that task bound, wherever it is collected."""
    log = get_logger()

    def log_uncaught_exception(exception_type, exception, traceback) -> None:
        log.critical("uncaught exception", exc_info=(exception_type, exception, traceback))

    def log_unhandled_task_error(_loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
        exception = context.get("exception")
        log.error("unhandled error in a background task", detail=str(context.get("message", "")),
                  exc_info=(type(exception), exception, exception.__traceback__) if exception else None)

    sys.excepthook = log_uncaught_exception
    loop.set_exception_handler(log_unhandled_task_error)
