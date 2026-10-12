"""The recognize worker: `python -m workers.recognize`.

For each job: drop it if the API has stopped waiting (its deadline passed), then decode (capped at
1 second), fingerprint, look up (800 ms) and decide, in a pool process. The answer is the matched
recording's number and the match facts, or a failure code; never an ad, a station or error text.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import sys
import time
from collections.abc import Callable
from typing import Any

import psycopg

from lookup_fingerprint import FINGERPRINT_VERSION

from .engine_pool import EnginePool, EngineTaskTimedOut
from .engine_process import ready, recognize_clip_in_process, start_recognize_process
from .fingerprint_store_check import check_fingerprint_store
from .job_failure import JobFailure
from .queue_runner import run_from_command_line, run_queue_worker
from .settings import WorkerSettings
from .worker_logging import get_logger

QUEUE_NAME = "recognize"
JOB_FIELDS = frozenset({"request_id", "audio_base64", "codec", "deadline_epoch_milliseconds", "fingerprint_version"})
DECODE_SECONDS = 1.0
# A clip never holds a process for longer than this. It is fixed, not "what is left of the deadline":
# a clip that waited in the queue must not get a sliver of time and be abandoned, which replaces the
# pool and costs every other clip in it a retry.
HARD_CAP_SECONDS = 2.5
# With less than this left before the API stops waiting, the answer could not arrive in time.
MINIMUM_USEFUL_MILLISECONDS = 300
DATABASE_CONNECT_TIMEOUT_SECONDS = 10

EXPIRED_RESULT = {"status": "EXPIRED", "audio_asset_number": None, "aligned_hash_count": 0, "match_margin": None,
                  "match_offset_milliseconds": None}


class RecognizeJobHandler:
    def __init__(self, pool, fingerprint_version: int = FINGERPRINT_VERSION, clock: Callable[[], float] = time.time,
                 recognize_function=recognize_clip_in_process) -> None:
        self._pool = pool
        self._fingerprint_version = fingerprint_version
        self._clock = clock
        self._recognize_function = recognize_function
        self._log = get_logger()

    async def __call__(self, job_data: dict[str, Any], attempts_made: int = 0) -> dict[str, Any]:
        if set(job_data) != JOB_FIELDS:
            raise JobFailure("ENGINE_FAILED")
        milliseconds_left = job_data["deadline_epoch_milliseconds"] - self._clock() * 1000
        if milliseconds_left < MINIMUM_USEFUL_MILLISECONDS:
            return dict(EXPIRED_RESULT)
        if job_data["fingerprint_version"] != self._fingerprint_version:
            raise JobFailure("FINGERPRINT_VERSION_MISMATCH")
        try:
            clip = base64.b64decode(job_data["audio_base64"], validate=True)
        except (binascii.Error, ValueError, TypeError):
            raise JobFailure("INVALID_AUDIO") from None

        try:
            outcome = await self._pool.run(self._recognize_function, clip, DECODE_SECONDS, timeout_seconds=HARD_CAP_SECONDS)
        except EngineTaskTimedOut:
            raise JobFailure("DECODE_TIMEOUT") from None
        if "failure" in outcome:
            raise JobFailure(outcome["failure"])
        self._log.info("clip recognized", status=outcome["result"]["status"],
                       aligned_hash_count=outcome["result"]["aligned_hash_count"], **outcome.get("timings_milliseconds", {}))
        return outcome["result"]


def check_database_connection(database_url: str) -> None:
    """Connects once from the worker's own process, with a time limit, so an unreachable database stops
    the worker at once with one log line naming the error. Without it the database would first be met
    inside the pool's processes, which wait far longer for a connection: the worker would sit through
    the pool's two-minute warm-up and then stop on a time-out that never names the database. It also stops a worker
    whose fingerprint version has no hash table yet (the migrations were not run), which would fail every clip."""
    with psycopg.connect(database_url, connect_timeout=DATABASE_CONNECT_TIMEOUT_SECONDS) as connection:
        connection.execute("SELECT 1")
        check_fingerprint_store(connection)


async def start(settings: WorkerSettings) -> None:
    await asyncio.to_thread(check_database_connection, settings.fingerprint_database_url)
    pool = EnginePool(settings.concurrency, start_recognize_process, (settings.fingerprint_database_url,))
    try:
        await pool.warm_up(ready)
        await run_queue_worker(settings, QUEUE_NAME, RecognizeJobHandler(pool), unexpected_failure_code="ENGINE_FAILED")
    finally:
        pool.shutdown()


if __name__ == "__main__":
    sys.exit(run_from_command_line(QUEUE_NAME, start))
