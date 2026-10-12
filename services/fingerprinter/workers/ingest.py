"""The ingest worker: `python -m workers.ingest`.

For each job: download the uploaded ad through the short-lived address in the job (the worker has no
storage credentials), compare its SHA-256 with the recordings already stored (an exact copy is linked,
not fingerprinted again, unless that recording is still on an older fingerprint version: then it is
fingerprinted with the current one first, so the ad can be recognised), otherwise decode it to the canonical form in a pool process, check its
length (5 to 120 seconds) before fingerprinting, and store it. The ad becomes READY, or FAILED with a
reason a station can read. Temporary trouble (the download, the database) fails the attempt, and
BullMQ tries again after a growing delay.

The same queue carries re-fingerprint jobs (a new fingerprint version, ADR-001): they name a stored
recording instead of an ad. The download must be that recording, byte for byte (its SHA-256), before it is
fingerprinted with the current version's settings; no ad changes and nothing is de-duplicated.
"""

from __future__ import annotations

import asyncio
import hashlib
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

from lookup_fingerprint import FINGERPRINT_VERSION

from .engine_pool import EnginePool, EngineTaskTimedOut
from .engine_process import MAXIMUM_UPLOAD_BYTES, prepare_ad_audio_in_process, ready, start_ingest_process
from .ingest_store import IngestStore
from .job_failure import JobFailure
from .queue_runner import run_from_command_line, run_queue_worker
from .settings import WorkerSettings
from .worker_logging import get_logger

QUEUE_NAME = "ingest"
JOB_FIELDS = frozenset({"request_id", "ad_id", "download_address", "deadline_epoch_milliseconds", "fingerprint_version"})
REFINGERPRINT_JOB_FIELDS = frozenset({"request_id", "audio_asset_number", "download_address", "deadline_epoch_milliseconds", "fingerprint_version"})
DOWNLOAD_TIMEOUT_SECONDS = 30.0
# The decode itself is capped at 30 s inside the process; this is the hard stop around it.
PREPARE_HARD_CAP_SECONDS = 45.0


class UploadTooLarge(Exception):
    pass


def download_upload(address: str, maximum_bytes: int = MAXIMUM_UPLOAD_BYTES, timeout_seconds: float = DOWNLOAD_TIMEOUT_SECONDS) -> bytes:
    """GET the uploaded file through its presigned address, reading at most one byte past the limit."""
    if urlsplit(address).scheme not in ("http", "https"):
        raise ValueError("the download address must be http or https")
    with urllib.request.urlopen(urllib.request.Request(address, method="GET"), timeout=timeout_seconds) as response:
        body = response.read(maximum_bytes + 1)
    if len(body) > maximum_bytes:
        raise UploadTooLarge()
    return body


def _result(outcome: str, is_linked_to_existing_audio: bool = False) -> dict[str, Any]:
    return {"outcome": outcome, "is_linked_to_existing_audio": is_linked_to_existing_audio}


def _refingerprint_result(outcome: str, hash_count: int | None = None) -> dict[str, Any]:
    return {"outcome": outcome, "hash_count": hash_count}


class IngestJobHandler:
    def __init__(self, pool, store: IngestStore, download: Callable[[str], bytes] = download_upload,
                 fingerprint_version: int = FINGERPRINT_VERSION, clock: Callable[[], float] = time.time) -> None:
        self._pool = pool
        self._store = store
        self._download = download
        self._fingerprint_version = fingerprint_version
        self._clock = clock
        self._log = get_logger()

    async def __call__(self, job_data: dict[str, Any], attempts_made: int = 0) -> dict[str, Any]:
        if set(job_data) == REFINGERPRINT_JOB_FIELDS:
            return await self._refingerprint(job_data, attempts_made)
        if set(job_data) != JOB_FIELDS:
            raise JobFailure("INGEST_JOB_MALFORMED")
        if job_data["deadline_epoch_milliseconds"] <= self._clock() * 1000:
            return _result("EXPIRED")
        if job_data["fingerprint_version"] != self._fingerprint_version:
            raise JobFailure("FINGERPRINT_VERSION_MISMATCH")
        ad_id, request_id = job_data["ad_id"], job_data["request_id"]

        try:
            file_bytes = await asyncio.to_thread(self._download, job_data["download_address"])
        except UploadTooLarge:
            return await self._refuse(ad_id, None, "audio_unreadable", request_id)
        except (urllib.error.URLError, OSError, ValueError) as problem:
            self._log.warning("the upload could not be downloaded", problem=type(problem).__name__, attempt=attempts_made + 1)
            raise JobFailure("DOWNLOAD_FAILED") from None
        content_sha256 = hashlib.sha256(file_bytes).digest()

        existing = await asyncio.to_thread(self._store.find_audio_asset, content_sha256)
        if existing is not None:
            if existing.fingerprint_version < self._fingerprint_version:
                # The same bytes as a recording still on an older version: the current version's table has none of
                # its hashes, so the ad would never be recognised. Fingerprint them now (another job may get there
                # first, which is just as good).
                prepared = await self._prepare(file_bytes)
                if "refusal_reason" in prepared:
                    return await self._refuse(ad_id, content_sha256, prepared["refusal_reason"], request_id)
                await asyncio.to_thread(self._store.store_refingerprinted_audio, existing.asset_number, prepared)
            changed = await asyncio.to_thread(self._store.record_result, ad_id, existing.audio_asset_id, content_sha256, None, request_id)
            return _result("READY" if changed else "SKIPPED", is_linked_to_existing_audio=True)

        prepared = await self._prepare(file_bytes)
        if "refusal_reason" in prepared:
            return await self._refuse(ad_id, content_sha256, prepared["refusal_reason"], request_id)

        stored = await asyncio.to_thread(self._store.store_new_audio, ad_id, content_sha256, prepared, request_id)
        return _result("READY" if stored.ad_changed else "SKIPPED", is_linked_to_existing_audio=stored.linked_to_existing_audio)

    async def _refingerprint(self, job_data: dict[str, Any], attempts_made: int) -> dict[str, Any]:
        if job_data["deadline_epoch_milliseconds"] <= self._clock() * 1000:
            return _refingerprint_result("EXPIRED")
        if job_data["fingerprint_version"] != self._fingerprint_version:
            raise JobFailure("FINGERPRINT_VERSION_MISMATCH")
        audio_asset_number = job_data["audio_asset_number"]
        if not isinstance(audio_asset_number, int) or isinstance(audio_asset_number, bool) or audio_asset_number < 1:
            raise JobFailure("INGEST_JOB_MALFORMED")

        recording = await asyncio.to_thread(self._store.find_recording, audio_asset_number)
        if recording is None or recording.fingerprint_version >= self._fingerprint_version:
            return _refingerprint_result("SKIPPED")
        try:
            file_bytes = await asyncio.to_thread(self._download, job_data["download_address"])
        except UploadTooLarge:
            self._log.warning("the recording was not re-fingerprinted", refusal_reason="audio_unreadable")
            return _refingerprint_result("REFUSED")
        except (urllib.error.URLError, OSError, ValueError) as problem:
            self._log.warning("the recording could not be downloaded", problem=type(problem).__name__, attempt=attempts_made + 1)
            raise JobFailure("DOWNLOAD_FAILED") from None
        if hashlib.sha256(file_bytes).digest() != recording.content_sha256:
            self._log.warning("the recording was not re-fingerprinted", refusal_reason="download_is_not_the_recording")
            return _refingerprint_result("REFUSED")

        prepared = await self._prepare(file_bytes)
        if "refusal_reason" in prepared:
            self._log.warning("the recording was not re-fingerprinted", refusal_reason=prepared["refusal_reason"])
            return _refingerprint_result("REFUSED")

        stored = await asyncio.to_thread(self._store.store_refingerprinted_audio, audio_asset_number, prepared)
        return _refingerprint_result("REFINGERPRINTED", len(prepared["hashes"])) if stored else _refingerprint_result("SKIPPED")

    async def _prepare(self, file_bytes: bytes) -> dict[str, Any]:
        """Decode and fingerprint in a pool process: the prepared audio, or {"refusal_reason": ...}."""
        try:
            return await self._pool.run(prepare_ad_audio_in_process, file_bytes, timeout_seconds=PREPARE_HARD_CAP_SECONDS)
        except EngineTaskTimedOut:
            return {"refusal_reason": "audio_took_too_long_to_read"}

    async def _refuse(self, ad_id: str, content_sha256: bytes | None, reason: str, request_id: str) -> dict[str, Any]:
        changed = await asyncio.to_thread(self._store.record_result, ad_id, None, content_sha256, reason, request_id)
        self._log.info("the upload was refused", refusal_reason=reason)
        return _result("REFUSED" if changed else "SKIPPED")


async def start(settings: WorkerSettings) -> None:
    pool = EnginePool(settings.concurrency, start_ingest_process)
    store = IngestStore(settings.fingerprint_database_url)
    try:
        await pool.warm_up(ready)
        await asyncio.to_thread(store.check_fingerprint_store)          # fails fast if the database is unreachable or not migrated
        await run_queue_worker(settings, QUEUE_NAME, IngestJobHandler(pool, store), unexpected_failure_code="INGEST_FAILED")
    finally:
        pool.shutdown()
        store.close()


if __name__ == "__main__":
    sys.exit(run_from_command_line(QUEUE_NAME, start))
