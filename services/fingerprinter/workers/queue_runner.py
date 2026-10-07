"""What both workers share: start-up checks, the BullMQ worker on its queue, the heartbeat, a clean
stop on Ctrl+C or SIGTERM, and one log line per job carrying its request id.

A start-up failure (bad settings, Valkey or Postgres unreachable) is one structured line with the
stack and a non-zero exit; connection strings and passwords never appear in it.
"""

from __future__ import annotations

import asyncio
import signal
import time
from collections.abc import Awaitable, Callable
from typing import Any

import redis.asyncio
import structlog
from bullmq import Worker

from .heartbeat import heartbeat_key, keep_heartbeat
from .job_failure import JobFailure
from .settings import SettingsError, WorkerSettings, load_settings
from .worker_logging import configure_logging, get_logger, install_crash_handlers

JobHandler = Callable[..., Awaitable[dict[str, Any]]]


def _stop_on_signals(loop: asyncio.AbstractEventLoop, stop: asyncio.Event) -> None:
    for signal_number in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signal_number, stop.set)
        except (NotImplementedError, RuntimeError, ValueError):     # Windows has no loop signal handlers
            signal.signal(signal_number, lambda *_: loop.call_soon_threadsafe(stop.set))


def job_processor(queue_name: str, handle_job: JobHandler, unexpected_failure_code: str) -> Callable[..., Awaitable[dict[str, Any]]]:
    """Wraps a handler for BullMQ: binds the request id to every log line written while the job runs,
    logs the outcome once, and turns anything unexpected into a code (with the stack in the log only).
    Everything, reading the job included, is inside the guard: a failure BullMQ swallowed would leave no
    trace at all."""
    log = get_logger()

    async def process(job, _token=None) -> dict[str, Any]:
        started_at = time.perf_counter()
        with structlog.contextvars.bound_contextvars(queue=queue_name, job_id=str(getattr(job, "id", "")), request_id=""):
            try:
                job_data = job.data if isinstance(job.data, dict) else {}
                structlog.contextvars.bind_contextvars(request_id=str(job_data.get("request_id", ""))[:64])
                result = await handle_job(job_data, attempts_made=getattr(job, "attemptsMade", 0))
            except JobFailure as failure:
                log.warning("job failed", code=failure.code, milliseconds=round((time.perf_counter() - started_at) * 1000))
                raise
            except Exception:
                log.error("job failed unexpectedly", code=unexpected_failure_code, exc_info=True)
                raise JobFailure(unexpected_failure_code) from None
            log.info("job finished", **{key: value for key, value in result.items() if key in ("status", "outcome")},
                     milliseconds=round((time.perf_counter() - started_at) * 1000))
            return result

    return process


async def run_queue_worker(settings: WorkerSettings, queue_name: str, handle_job: JobHandler, unexpected_failure_code: str,
                           stop: asyncio.Event | None = None) -> None:
    loop = asyncio.get_running_loop()
    install_crash_handlers(loop)
    log = get_logger(queue=queue_name)
    stop = stop or asyncio.Event()
    _stop_on_signals(loop, stop)

    key_value_store = redis.asyncio.from_url(settings.key_value_store_url, socket_timeout=5, socket_connect_timeout=5)
    await key_value_store.ping()
    worker = Worker(queue_name, job_processor(queue_name, handle_job, unexpected_failure_code), {
        "connection": settings.key_value_store_url,
        "prefix": settings.queue_key_prefix,
        "concurrency": settings.concurrency,
    })
    heartbeat = asyncio.create_task(keep_heartbeat(key_value_store, heartbeat_key(settings.queue_key_prefix, queue_name), stop))
    log.info("worker started", concurrency=settings.concurrency)
    stopping = asyncio.create_task(stop.wait())
    try:
        await asyncio.wait({stopping, heartbeat}, return_when=asyncio.FIRST_COMPLETED)
        if heartbeat.done() and not stop.is_set():
            # The heartbeat never ends while the worker runs; if it has, stop loudly so the platform restarts us.
            heartbeat.result()
            raise RuntimeError("the heartbeat stopped while the worker was running")
    finally:
        log.info("worker stopping")
        stop.set()
        stopping.cancel()
        await worker.close()
        await asyncio.gather(heartbeat, return_exceptions=True)
        await key_value_store.aclose()


def run_from_command_line(queue_name: str, start: Callable[[WorkerSettings], Awaitable[None]]) -> int:
    try:
        settings = load_settings()
    except SettingsError as problem:
        configure_logging("INFO")
        get_logger(queue=queue_name).critical("the worker cannot start: its settings are wrong", problems=str(problem))
        return 2
    configure_logging(settings.log_level)
    try:
        asyncio.run(start(settings))
    except KeyboardInterrupt:
        return 0
    except Exception:
        get_logger(queue=queue_name).critical("the worker stopped on an error", exc_info=True)
        return 1
    return 0
