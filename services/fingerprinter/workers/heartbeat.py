"""The heartbeat: a key with a short expiry that a running worker keeps refreshing.

The API refuses a recognition at once (503 with Retry-After) when no recognize worker's heartbeat
exists, rather than waiting 2.5 seconds for an answer that cannot come. A killed worker's key is gone
within the expiry; a worker that stops cleanly deletes it straight away.

A beat that fails (Valkey restarting, a dropped connection) is logged and tried again at the next
interval: the heartbeat never stops by itself while the worker runs. If it ever does end, the worker
stops too (queue_runner.py), so the platform restarts it rather than leaving it working unseen.
"""

from __future__ import annotations

import asyncio
import time

from .worker_logging import get_logger

HEARTBEAT_INTERVAL_SECONDS = 5.0
HEARTBEAT_EXPIRY_MILLISECONDS = 15_000


def heartbeat_key(queue_key_prefix: str, queue_name: str) -> str:
    return f"{queue_key_prefix}:worker-heartbeat:{queue_name}"


async def keep_heartbeat(key_value_store, key: str, stop: asyncio.Event,
                         interval_seconds: float = HEARTBEAT_INTERVAL_SECONDS,
                         expiry_milliseconds: int = HEARTBEAT_EXPIRY_MILLISECONDS) -> None:
    """Writes the key now and every interval until `stop` is set, then deletes it (if it can)."""
    log = get_logger()
    was_failing = False
    try:
        while not stop.is_set():
            try:
                await asyncio.wait_for(key_value_store.set(key, str(int(time.time() * 1000)), px=expiry_milliseconds),
                                       timeout=interval_seconds)
                if was_failing:
                    log.info("the heartbeat is being written again")
                was_failing = False
            except Exception:
                if not was_failing:
                    log.error("the heartbeat could not be written; trying again", exc_info=True)
                was_failing = True
            try:
                await asyncio.wait_for(stop.wait(), timeout=interval_seconds)
            except TimeoutError:
                pass
    finally:
        try:
            await asyncio.wait_for(key_value_store.delete(key), timeout=2.0)
        except Exception:
            pass  # it expires by itself
