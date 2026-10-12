"""S3-ERRORS-10: when the workers lose Postgres or Valkey, the failure goes through the central path.

At start-up a real worker process (`python -m workers.recognize` or `workers.ingest`) stops with a
non-zero exit and exactly one structured fatal line with the stack, and nothing it writes holds a
password. During a job, the job fails with its code only, and the one error line carries the job's
request id and the stack. These need the compose Valkey and Postgres; with them down, they fail.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

import psycopg
import pytest

from workers import engine_process
from workers.ingest import IngestJobHandler
from workers.ingest_store import IngestStore
from workers.job_failure import JobFailure
from workers.queue_runner import job_processor
from workers.recognize import RecognizeJobHandler
from workers.settings import STORAGE_CREDENTIAL_NAMES
from workers.worker_logging import configure_logging

from .test_workers import FakePool, aac_clip_bytes, ingest_job, recognize_job
from .worker_support import fingerprint_worker_database_url, key_value_store_url, setting, setup_database_url

SERVICE_ROOT = Path(__file__).resolve().parents[1]
# Port 1 has nothing listening: these look like real settings but reach nothing.
UNREACHABLE_KEY_VALUE_STORE_URL = "redis://:a-secret-valkey-password@127.0.0.1:1/0"
UNREACHABLE_DATABASE_URL = "postgresql://lookup_fingerprint_worker:a-secret-database-password@127.0.0.1:1/lookup"
# Enough for the pool's process to start and a connection to time out (10 s) on a slow machine; the
# recognize worker used to need over two minutes to give up on an unreachable database.
START_UP_FAILURE_SECONDS = 60


def _parse_every_line(output: str) -> list[dict]:
    lines = []
    for text in output.splitlines():
        if text.strip():
            try:
                lines.append(json.loads(text))
            except json.JSONDecodeError:
                raise AssertionError(f"a line that is not JSON (a bare traceback?): {text[:300]}") from None
    return lines


def _start_worker(module: str, key_value_store: str, database: str) -> tuple[str, int]:
    """Runs the worker as the platform would and returns everything it wrote (both streams) and its exit code."""
    environment = {name: value for name, value in os.environ.items() if not STORAGE_CREDENTIAL_NAMES.match(name)}
    environment.update(KEY_VALUE_STORE_URL=key_value_store, FINGERPRINT_DATABASE_URL=database, WORKER_CONCURRENCY="1",
                       LOG_LEVEL="INFO", QUEUE_KEY_PREFIX="lookup-test-start-up")
    finished = subprocess.run([sys.executable, "-m", module], cwd=SERVICE_ROOT, env=environment, capture_output=True,
                              text=True, encoding="utf-8", errors="replace", timeout=START_UP_FAILURE_SECONDS)
    return finished.stdout + finished.stderr, finished.returncode


def _is_a_stack_naming(stack: str, error_module: str) -> bool:
    """A Python stack trace whose error line (at the end, not cut off by the length limit) is from `error_module`."""
    return stack.startswith("Traceback") and any(line.startswith(error_module) for line in stack.splitlines())


def _assert_one_fatal_line_naming(output: str, error_module: str) -> None:
    lines = _parse_every_line(output)
    fatal_lines = [line for line in lines if line["level"] == "critical"]
    assert len(fatal_lines) == 1, [line["message"] for line in lines]
    assert _is_a_stack_naming(fatal_lines[0]["exception"], error_module), fatal_lines[0]["exception"][-500:]


@pytest.mark.parametrize("module", ["workers.recognize", "workers.ingest"])
def test_a_worker_that_cannot_reach_postgres_at_start_up_stops_with_one_fatal_line_and_no_password(module):
    output, exit_code = _start_worker(module, key_value_store_url(), UNREACHABLE_DATABASE_URL)
    assert exit_code != 0
    _assert_one_fatal_line_naming(output, "psycopg.")
    for secret in ("a-secret-database-password", urlsplit(key_value_store_url()).password):
        assert secret not in output


@pytest.mark.parametrize("module", ["workers.recognize", "workers.ingest"])
def test_a_worker_that_cannot_reach_valkey_at_start_up_stops_with_one_fatal_line_and_no_password(module):
    output, exit_code = _start_worker(module, UNREACHABLE_KEY_VALUE_STORE_URL, fingerprint_worker_database_url())
    assert exit_code != 0
    _assert_one_fatal_line_naming(output, "redis.")
    for secret in ("a-secret-valkey-password", setting("LOOKUP_FINGERPRINT_WORKER_DATABASE_PASSWORD")):
        assert secret not in output


def test_a_worker_stops_at_start_up_when_its_fingerprint_version_has_no_hash_table(monkeypatch):
    """A worker started before the migrations would report healthy and then fail every job (ADR-001, version 2)."""
    from workers import fingerprint_store_check, recognize
    from workers.fingerprint_store_check import FingerprintStoreMissing

    recognize.check_database_connection(fingerprint_worker_database_url())
    IngestStore(fingerprint_worker_database_url()).check_fingerprint_store()

    monkeypatch.setattr(fingerprint_store_check, "FINGERPRINT_VERSION", 99)
    for check in (lambda: recognize.check_database_connection(fingerprint_worker_database_url()),
                  lambda: IngestStore(fingerprint_worker_database_url()).check_fingerprint_store()):
        with pytest.raises(FingerprintStoreMissing, match=r"no hash table for fingerprint version 99 .*npm run database:migrate"):
            check()


def test_the_ingest_worker_also_needs_the_re_fingerprint_function_and_the_recognize_worker_does_not(monkeypatch):
    from workers import fingerprint_store_check, recognize
    from workers.fingerprint_store_check import FingerprintStoreMissing

    monkeypatch.setattr(fingerprint_store_check, "REFINGERPRINT_FUNCTION", "fingerprints.no_such_function(integer)")
    recognize.check_database_connection(fingerprint_worker_database_url())
    with pytest.raises(FingerprintStoreMissing, match=r"no fingerprints\.no_such_function"):
        IngestStore(fingerprint_worker_database_url()).check_fingerprint_store()


# ---- during a job ------------------------------------------------------------------------------------


def _end_on_the_server(connection: psycopg.Connection) -> None:
    """Ends one worker connection from the database side, as a Postgres restart would; nothing else is touched."""
    with psycopg.connect(setup_database_url(), autocommit=True) as setup:
        assert setup.execute("SELECT pg_terminate_backend(%s, 5000)", (connection.info.backend_pid,)).fetchone()[0]


class _InlinePool:
    """Runs the engine in the calling thread: the pool is not what these tests are about."""

    async def run(self, function, *arguments, timeout_seconds):
        return function(*arguments)


def _error_lines(stream: io.StringIO) -> list[dict]:
    return [line for line in _parse_every_line(stream.getvalue()) if line["level"] == "error"]


def test_a_recognize_job_that_loses_the_database_fails_with_a_code_and_the_next_job_connects_again(monkeypatch):
    monkeypatch.setattr(engine_process, "_database_url", fingerprint_worker_database_url())
    monkeypatch.setattr(engine_process, "_matcher", None)
    stream = io.StringIO()
    configure_logging("INFO", stream)
    process = job_processor("recognize", RecognizeJobHandler(_InlinePool()), "ENGINE_FAILED")
    clip = base64.b64encode(aac_clip_bytes()).decode()

    def recognize(request_id: str) -> dict:
        job = SimpleNamespace(id=request_id, data=recognize_job(request_id=request_id, audio_base64=clip), attemptsMade=0)
        return asyncio.run(process(job))

    lost_connection = None
    try:
        assert recognize("before-the-database-is-lost")["status"] in ("MATCH", "AMBIGUOUS", "NO_MATCH")
        lost_connection = engine_process._matcher.index.connection
        _end_on_the_server(lost_connection)
        with pytest.raises(JobFailure) as failed:
            recognize("while-the-database-is-lost")
        assert recognize("after-the-database-is-back")["status"] in ("MATCH", "AMBIGUOUS", "NO_MATCH")
    finally:
        if lost_connection is not None:
            lost_connection.close()
        if engine_process._matcher is not None:
            engine_process._matcher.index.close()

    assert str(failed.value) == "ENGINE_FAILED"
    (error_line,) = _error_lines(stream)
    assert (error_line["request_id"], error_line["code"]) == ("while-the-database-is-lost", "ENGINE_FAILED")
    assert _is_a_stack_naming(error_line["exception"], "psycopg.")
    assert setting("LOOKUP_FINGERPRINT_WORKER_DATABASE_PASSWORD") not in stream.getvalue()


class _StoreThatLosesItsDatabase(IngestStore):
    """Every connection it opens is ended on the server straight away, as if Postgres had just restarted."""

    def _connect(self) -> psycopg.Connection:
        connection = super()._connect()
        _end_on_the_server(connection)
        return connection


def test_an_ingest_job_that_loses_the_database_fails_with_a_code_its_request_id_and_the_stack():
    stream = io.StringIO()
    configure_logging("INFO", stream)
    handler = IngestJobHandler(FakePool(), _StoreThatLosesItsDatabase(fingerprint_worker_database_url()),
                               download=lambda address: b"RIFF the uploaded ad")
    job = SimpleNamespace(id="41", data=ingest_job(request_id="ingest-while-the-database-is-lost"), attemptsMade=0)
    with pytest.raises(JobFailure) as failed:
        asyncio.run(job_processor("ingest", handler, "INGEST_FAILED")(job))

    assert str(failed.value) == "INGEST_FAILED"           # BullMQ stores str(error): the code and nothing else
    (error_line,) = _error_lines(stream)
    assert (error_line["request_id"], error_line["code"]) == ("ingest-while-the-database-is-lost", "INGEST_FAILED")
    assert _is_a_stack_naming(error_line["exception"], "psycopg.")
    for secret in (setting("LOOKUP_FINGERPRINT_WORKER_DATABASE_PASSWORD"), "X-Amz-Signature"):
        assert secret not in stream.getvalue()
