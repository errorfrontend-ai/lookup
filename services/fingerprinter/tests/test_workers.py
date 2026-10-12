"""The queue workers without the queue: settings, logging, the heartbeat, the process pool, and the
recognize and ingest job handlers (with the engine, the store and the download stood in for where the
test is about the handler). The real queue, end to end with the Node API, is tested in the API suite.
"""

from __future__ import annotations

import asyncio
import base64
import gc
import hashlib
import inspect
import io
import json
import os
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import redis.asyncio
import structlog
from scipy.signal import resample_poly

from bench.synthetic_audio import SOURCE_SAMPLE_RATE, synthesize_ad, write_aac, write_wav
from lookup_fingerprint import FINGERPRINT_VERSION, FingerprintParameters, MatchThresholds, Matcher, MemoryIndex, PostgresIndex, fingerprint
from workers import engine_process
from workers.engine_pool import EnginePool, EngineTaskTimedOut
from workers.heartbeat import heartbeat_key, keep_heartbeat
from workers.ingest import IngestJobHandler, UploadTooLarge
from workers.ingest_store import ExistingAsset, StoreOutcome, StoredRecording
from workers.job_failure import JobFailure
from workers.queue_runner import job_processor
from workers.recognize import EXPIRED_RESULT, RecognizeJobHandler
from workers.settings import SettingsError, load_settings
from workers.worker_logging import configure_logging, get_logger, install_crash_handlers

from .worker_support import assert_matches_contract, key_value_store_url

# ---- helpers for the pool tests (module level, so a spawned process can find them) ---------------------


def process_id_after(seconds: float) -> int:
    time.sleep(seconds)
    return os.getpid()


def sleep_for(seconds: float) -> str:
    time.sleep(seconds)
    return "finished"


class FakePool:
    """Stands in for the process pool: answers each call with the next canned answer, or raises it."""

    def __init__(self, *answers) -> None:
        self.answers = list(answers)
        self.calls: list[tuple] = []

    async def run(self, function, *arguments, timeout_seconds):
        self.calls.append((function.__name__, arguments, timeout_seconds))
        answer = self.answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return answer


def wav_bytes(seconds: float, sample_rate: int = 8000, seed: int = 3) -> bytes:
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "ad.wav"
        write_wav(path, synthesize_ad(seed, seconds, sample_rate=sample_rate), sample_rate)
        return path.read_bytes()


# ---- settings ----------------------------------------------------------------------------------------

GOOD_ENVIRONMENT = {
    "KEY_VALUE_STORE_URL": "redis://:secret-valkey-password@127.0.0.1:56379/0",
    "FINGERPRINT_DATABASE_URL": "postgresql://lookup_fingerprint_worker:secret-db-password@127.0.0.1:55432/lookup",
}


def test_settings_are_read_from_the_environment_with_safe_defaults():
    settings = load_settings(GOOD_ENVIRONMENT)
    assert (settings.queue_key_prefix, settings.concurrency, settings.log_level) == ("lookup", 2, "INFO")


@pytest.mark.parametrize(("changes", "named"), [
    ({"KEY_VALUE_STORE_URL": ""}, "KEY_VALUE_STORE_URL is missing"),
    ({"FINGERPRINT_DATABASE_URL": "postgresql://lookup_api:secret-db-password@127.0.0.1:55432/lookup"}, "must connect as lookup_fingerprint_worker"),
    ({"WORKER_CONCURRENCY": "0"}, "WORKER_CONCURRENCY"),
    ({"OBJECT_STORAGE_SECRET_ACCESS_KEY": "secret-storage-key"}, "OBJECT_STORAGE_SECRET_ACCESS_KEY"),
    ({"AWS_ACCESS_KEY_ID": "AKIA-secret"}, "AWS_ACCESS_KEY_ID"),
])
def test_bad_settings_stop_the_worker_naming_the_setting_never_its_value(changes, named):
    with pytest.raises(SettingsError) as refused:
        load_settings({**GOOD_ENVIRONMENT, **changes})
    assert named in str(refused.value)
    for secret in ("secret-valkey-password", "secret-db-password", "secret-storage-key", "AKIA-secret"):
        assert secret not in str(refused.value)


# ---- logging -----------------------------------------------------------------------------------------


def _log_lines(stream: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]


def test_log_lines_are_json_with_time_level_message_and_the_jobs_request_id():
    stream = io.StringIO()
    configure_logging("INFO", stream)

    async def handle(job_data, attempts_made=0):
        get_logger().info("working on it")
        return {"status": "NO_MATCH"}

    # Only what a real bullmq.Job has: id, data and attemptsMade (there is no queue name on it).
    job = SimpleNamespace(id="17", data={"request_id": "request-for-the-log", "audio_base64": "QUJD"}, attemptsMade=0)
    asyncio.run(job_processor("recognize", handle, "ENGINE_FAILED")(job))
    lines = _log_lines(stream)
    assert [line["message"] for line in lines] == ["working on it", "job finished"]
    for line in lines:
        assert line["request_id"] == "request-for-the-log"
        assert {"timestamp", "level", "message"} <= set(line)
    assert "QUJD" not in stream.getvalue()


def test_audio_and_download_addresses_never_reach_a_log_line_and_long_values_are_cut():
    stream = io.StringIO()
    configure_logging("INFO", stream)
    get_logger().info("careless", audio_base64="QUJDREVG" * 100, download_address="https://storage/x?X-Amz-Signature=abc",
                      clip=b"\x00" * 50, note="n" * 10_000)
    line = _log_lines(stream)[0]
    assert line["audio_base64"] == line["download_address"] == line["clip"] == "[removed]"
    assert len(line["note"]) < 5_000
    assert "X-Amz-Signature" not in stream.getvalue()


def test_a_job_the_wrapper_cannot_even_read_still_fails_with_a_code_and_a_log_line():
    stream = io.StringIO()
    configure_logging("INFO", stream)

    class UnreadableJob:
        id, attemptsMade = "19", 0

        @property
        def data(self):
            raise RuntimeError("the job's data could not be read")

    with pytest.raises(JobFailure, match="ENGINE_FAILED"):
        asyncio.run(job_processor("recognize", lambda *arguments, **options: None, "ENGINE_FAILED")(UnreadableJob()))
    assert _log_lines(stream)[-1]["message"] == "job failed unexpectedly"


def test_an_unexpected_error_is_logged_with_its_stack_and_answered_with_a_code_only():
    stream = io.StringIO()
    configure_logging("INFO", stream)

    async def handle(job_data, attempts_made=0):
        raise ValueError("C:\\secret\\path.py exploded at line 9")

    job = SimpleNamespace(id="18", data={"request_id": "request-with-a-crash"}, attemptsMade=0)
    with pytest.raises(JobFailure) as failed:
        asyncio.run(job_processor("recognize", handle, "ENGINE_FAILED")(job))
    assert str(failed.value) == "ENGINE_FAILED"           # BullMQ stores str(error) as the failure reason
    error_line = _log_lines(stream)[-1]
    assert error_line["level"] == "error" and error_line["request_id"] == "request-with-a-crash"
    assert "Traceback" in error_line["exception"] and "exploded" in error_line["exception"]


def test_uncaught_errors_and_failed_background_tasks_become_structured_lines():
    stream = io.StringIO()
    configure_logging("INFO", stream)
    loop = asyncio.new_event_loop()
    try:
        install_crash_handlers(loop)
        try:
            raise RuntimeError("nobody caught this")
        except RuntimeError as error:
            import sys
            sys.excepthook(type(error), error, error.__traceback__)

        async def fail():
            raise KeyError("lost task")

        task = loop.create_task(fail())
        loop.run_until_complete(asyncio.sleep(0.01))
        del task                                            # an unretrieved task error reaches the loop's handler
        import gc
        gc.collect()
    finally:
        loop.close()
    lines = _log_lines(stream)
    assert lines[0]["level"] == "critical" and "nobody caught this" in lines[0]["exception"]
    assert any(line["level"] == "error" and "lost task" in line.get("exception", "") for line in lines[1:])


def test_a_failed_background_task_is_logged_once_with_its_own_request_id_and_stack():
    """S3-ERRORS-08: the loop reports the error wherever the task is collected; the line is written in
    the task's own context, so it carries the request id the task bound, not the one bound around it."""
    stream = io.StringIO()
    configure_logging("INFO", stream)
    loop = asyncio.new_event_loop()
    try:
        install_crash_handlers(loop)

        async def fail_while_working_on_a_job():
            structlog.contextvars.bind_contextvars(request_id="request-of-the-failed-task", job_id="31")
            raise KeyError("lost in the background")

        with structlog.contextvars.bound_contextvars(request_id="request-of-whoever-collects-the-task"):
            task = loop.create_task(fail_while_working_on_a_job())
            loop.run_until_complete(asyncio.sleep(0.01))
            del task                                        # its error is never retrieved: the loop's handler gets it
            gc.collect()
    finally:
        loop.close()
    lines = _log_lines(stream)
    assert len(lines) == 1
    assert (lines[0]["level"], lines[0].get("request_id"), lines[0].get("job_id")) == ("error", "request-of-the-failed-task", "31")
    assert lines[0]["exception"].startswith("Traceback") and "lost in the background" in lines[0]["exception"]


def test_a_long_stack_trace_is_shortened_but_keeps_the_error_it_ends_with():
    """A deep stack (a Valkey client retrying, say) is longer than a log value may be: the line keeps
    where it started and, above all, the last lines that name the error."""
    stream = io.StringIO()
    configure_logging("INFO", stream)

    def ping(depth: int) -> None:
        if depth == 0:
            raise ConnectionError("the error at the bottom of a deep stack")
        pong(depth - 1)

    def pong(depth: int) -> None:
        ping(depth)

    try:
        ping(80)
    except ConnectionError:
        get_logger().error("deep failure", exc_info=True)
    exception = _log_lines(stream)[0]["exception"]
    assert len(exception) < 5_000
    assert exception.startswith("Traceback")
    assert exception.rstrip().endswith("ConnectionError: the error at the bottom of a deep stack")


# ---- heartbeat ---------------------------------------------------------------------------------------


def test_the_heartbeat_key_is_kept_fresh_with_an_expiry_and_removed_on_stop():
    async def scenario():
        store = redis.asyncio.from_url(key_value_store_url())
        key = heartbeat_key("lookup-test-heartbeat", "recognize")
        stop = asyncio.Event()
        beating = asyncio.create_task(keep_heartbeat(store, key, stop, interval_seconds=0.2, expiry_milliseconds=1_000))
        await asyncio.sleep(0.5)
        expiry = await store.pttl(key)
        stop.set()
        await beating
        remaining = await store.exists(key)
        await store.aclose()
        return expiry, remaining

    expiry, remaining = asyncio.run(scenario())
    assert 0 < expiry <= 1_000
    assert remaining == 0


def test_a_killed_workers_heartbeat_expires_by_itself():
    """A real worker process is killed (no clean-up runs): its key is gone once its expiry passes."""
    import subprocess
    import sys

    key = heartbeat_key("lookup-test-heartbeat", "killed")
    program = chr(10).join([
        "import asyncio, redis.asyncio, sys",
        "from workers.heartbeat import keep_heartbeat",
        "store = redis.asyncio.from_url(sys.argv[1])",
        "asyncio.run(keep_heartbeat(store, sys.argv[2], asyncio.Event(), interval_seconds=0.1, expiry_milliseconds=600))",
    ])
    beating = subprocess.Popen([sys.executable, "-c", program, key_value_store_url(), key], cwd=Path(__file__).resolve().parents[1])

    async def scenario():
        store = redis.asyncio.from_url(key_value_store_url())
        started_at = time.monotonic()
        while not await store.exists(key):
            assert time.monotonic() - started_at < 30, "the heartbeat never appeared"
            await asyncio.sleep(0.1)
        beating.kill()
        beating.wait()
        present_right_after = await store.exists(key)
        await asyncio.sleep(1.0)
        present_after_expiry = await store.exists(key)
        await store.aclose()
        return present_right_after, present_after_expiry

    assert asyncio.run(scenario()) == (1, 0)


def test_the_heartbeat_rides_out_a_failing_store_and_beats_again_when_it_is_back():
    class FlakyStore:
        def __init__(self) -> None:
            self.calls = 0
            self.writes = 0

        async def set(self, key, value, px):
            self.calls += 1
            if self.calls in (2, 3):
                raise ConnectionError("Valkey is restarting")
            self.writes += 1

        async def delete(self, key):
            raise ConnectionError("still away")

    async def scenario():
        store = FlakyStore()
        stop = asyncio.Event()
        beating = asyncio.create_task(keep_heartbeat(store, "key", stop, interval_seconds=0.05, expiry_milliseconds=1_000))
        await asyncio.sleep(0.4)
        still_running = not beating.done()
        stop.set()
        await beating                                   # ends cleanly although the delete fails
        return store, still_running

    stream = io.StringIO()
    configure_logging("INFO", stream)
    store, still_running = asyncio.run(scenario())
    assert still_running and store.calls >= 5 and store.writes >= 3
    messages = [line["message"] for line in _log_lines(stream)]
    assert messages.count("the heartbeat could not be written; trying again") == 1
    assert "the heartbeat is being written again" in messages


# ---- the process pool --------------------------------------------------------------------------------


def test_two_jobs_run_in_different_processes_while_the_event_loop_stays_free():
    async def scenario():
        pool = EnginePool(2, engine_process.start_ingest_process)
        try:
            await pool.warm_up(engine_process.ready)
            ticks = 0

            async def count_ticks():
                nonlocal ticks
                while True:
                    await asyncio.sleep(0.05)
                    ticks += 1

            ticker = asyncio.create_task(count_ticks())
            process_ids = await asyncio.gather(pool.run(process_id_after, 0.6, timeout_seconds=10),
                                               pool.run(process_id_after, 0.6, timeout_seconds=10))
            ticker.cancel()
            return process_ids, ticks
        finally:
            pool.shutdown()

    process_ids, ticks = asyncio.run(scenario())
    assert len(set(process_ids)) == 2 and os.getpid() not in process_ids
    assert ticks >= 5           # the heartbeat and the queue would have kept running meanwhile


def test_a_task_past_its_hard_cap_is_abandoned_and_the_pool_carries_on():
    async def scenario():
        pool = EnginePool(1, engine_process.start_ingest_process)
        try:
            started_at = time.perf_counter()
            with pytest.raises(EngineTaskTimedOut):
                await pool.run(sleep_for, 30, timeout_seconds=0.5)
            stopped_after = time.perf_counter() - started_at
            after = await pool.run(sleep_for, 0, timeout_seconds=60)
            return stopped_after, after
        finally:
            pool.shutdown()

    stopped_after, after = asyncio.run(scenario())
    assert stopped_after < 5
    assert after == "finished"


def test_a_clip_caught_in_another_clips_overrun_is_run_again_not_failed():
    async def scenario():
        pool = EnginePool(2, engine_process.start_ingest_process)
        try:
            await pool.warm_up(engine_process.ready)
            stuck = asyncio.create_task(pool.run(sleep_for, 30, timeout_seconds=0.5))
            innocent = asyncio.create_task(pool.run(sleep_for, 1.5, timeout_seconds=30))
            with pytest.raises(EngineTaskTimedOut):
                await stuck
            return await innocent
        finally:
            pool.shutdown()

    assert asyncio.run(scenario()) == "finished"


def test_a_pool_whose_process_died_while_idle_is_replaced_and_the_task_still_runs():
    async def scenario():
        pool = EnginePool(1, engine_process.start_ingest_process)
        try:
            await pool.warm_up(engine_process.ready)
            for process in list(pool._executor._processes.values()):
                process.kill()
                process.join()
            return await pool.run(sleep_for, 0, timeout_seconds=60)
        finally:
            pool.shutdown()

    assert asyncio.run(scenario()) == "finished"


def test_a_job_with_too_little_time_left_is_dropped_rather_than_started():
    pool = FakePool()
    result = asyncio.run(RecognizeJobHandler(pool)(recognize_job(deadline_epoch_milliseconds=int(time.time() * 1000) + 100)))
    assert result == EXPIRED_RESULT and pool.calls == []


# ---- the recognize handler ---------------------------------------------------------------------------


def recognize_job(**changes) -> dict:
    return {"request_id": "r-1", "audio_base64": base64.b64encode(b"clip bytes").decode(), "codec": "aac",
            "deadline_epoch_milliseconds": int(time.time() * 1000) + 600_000, "fingerprint_version": FINGERPRINT_VERSION, **changes}


MATCH_RESULT = {"status": "MATCH", "audio_asset_number": 17, "aligned_hash_count": 42, "match_margin": None, "match_offset_milliseconds": 6016}


def test_a_job_past_its_deadline_is_dropped_without_decoding():
    pool = FakePool()
    result = asyncio.run(RecognizeJobHandler(pool)(recognize_job(deadline_epoch_milliseconds=int(time.time() * 1000) - 1)))
    assert result == EXPIRED_RESULT
    assert pool.calls == []
    assert_matches_contract(result, "recognize-job-result.schema.json")


def test_a_match_comes_back_in_the_contracts_shape_and_the_clip_is_capped():
    pool = FakePool({"result": MATCH_RESULT, "timings_milliseconds": {"decode": 12.0}})
    result = asyncio.run(RecognizeJobHandler(pool)(recognize_job()))
    assert result == MATCH_RESULT
    assert_matches_contract(result, "recognize-job-result.schema.json")
    (function_name, (clip, decode_seconds), timeout_seconds), = pool.calls
    assert function_name == "recognize_clip_in_process" and clip == b"clip bytes"
    assert decode_seconds == 1.0 and timeout_seconds == 2.5


@pytest.mark.parametrize(("job", "pool_answer", "code"), [
    (recognize_job(fingerprint_version=FINGERPRINT_VERSION + 1), None, "FINGERPRINT_VERSION_MISMATCH"),
    (recognize_job(audio_base64="not base64!"), None, "INVALID_AUDIO"),
    (recognize_job(), {"failure": "INVALID_AUDIO"}, "INVALID_AUDIO"),
    (recognize_job(), {"failure": "LOOKUP_TIMEOUT"}, "LOOKUP_TIMEOUT"),
    (recognize_job(), EngineTaskTimedOut(), "DECODE_TIMEOUT"),
    ({**recognize_job(), "station_id": "x"}, None, "ENGINE_FAILED"),
])
def test_failures_are_one_code_each(job, pool_answer, code):
    pool = FakePool(*([pool_answer] if pool_answer is not None else []))
    with pytest.raises(JobFailure) as failed:
        asyncio.run(RecognizeJobHandler(pool)(job))
    assert str(failed.value) == code


def test_the_engine_sits_behind_one_method_so_a_stand_in_engine_works(monkeypatch):
    """S3-ENGINE-13: anything with recognize_clip(bytes, deadline_seconds) can replace the matcher."""

    class StandInRecognition:
        class result:
            status, best, runner_up, margin_over_runner_up = "NO_MATCH", None, None, None
        timings_milliseconds = {"total": 1.0}

    class StandInEngine:
        parameters = None

        def recognize_clip(self, clip, deadline_seconds=None):
            return StandInRecognition()

    monkeypatch.setattr(engine_process, "_matcher_for_this_process", lambda: StandInEngine())
    outcome = engine_process.recognize_clip_in_process(b"anything", 1.0)
    assert outcome["result"] == {"status": "NO_MATCH", "audio_asset_number": None, "aligned_hash_count": 0,
                                 "match_margin": None, "match_offset_milliseconds": None}


CLIP_AD = synthesize_ad(11, 20.0, sample_rate=16_000)


def aac_clip_bytes(seconds: float = 8.0) -> bytes:
    """The first seconds of CLIP_AD as a phone would send them: AAC in an M4A container, 16 kHz."""
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "clip.m4a"
        write_aac(path, CLIP_AD[: int(seconds * 16_000)], 16_000, 32_000)
        return path.read_bytes()


@pytest.fixture()
def clip_engine(monkeypatch):
    """The real engine on the recognize path, with an in-memory index of the clip's own ad."""
    parameters = FingerprintParameters()
    index = MemoryIndex()
    index.add(5, fingerprint(resample_poly(CLIP_AD.astype(np.float64), parameters.sample_rate, 16_000).astype(np.float32), parameters))
    matcher = Matcher(index, parameters, MatchThresholds(minimum_aligned_landmarks=7, minimum_margin=2.0))
    monkeypatch.setattr(engine_process, "_matcher_for_this_process", lambda: matcher)
    return matcher


def test_a_listener_clip_never_touches_the_disk(clip_engine):
    """The clip is decoded from memory: the temporary folder and the working folder are the same before and after."""
    clip = aac_clip_bytes()
    folders = [Path(tempfile.gettempdir()), Path.cwd()]
    before = [set(folder.iterdir()) for folder in folders]
    outcome = engine_process.recognize_clip_in_process(clip, 1.0)
    assert outcome["result"]["status"] == "MATCH" and outcome["result"]["audio_asset_number"] == 5
    assert [set(folder.iterdir()) - seen for folder, seen in zip(folders, before)] == [set(), set()]


def test_an_ad_is_prepared_without_touching_the_disk():
    temporary_folder = Path(tempfile.gettempdir())
    before = set(temporary_folder.iterdir())
    outcome = engine_process.prepare_ad_audio_in_process(wav_bytes(6.0))
    assert "hashes" in outcome
    assert set(temporary_folder.iterdir()) - before == set()


def test_a_clip_goes_through_each_stage_once_in_order(clip_engine, monkeypatch):
    """Decode (to the canonical rate), fingerprint, look up, then decide: once each, in that order."""
    from lookup_fingerprint import matcher as matcher_module
    stages: list[str] = []

    def spy(name, function):
        def called(*arguments, **keywords):
            stages.append(name)
            return function(*arguments, **keywords)
        return called

    monkeypatch.setattr(matcher_module, "decode_audio", spy("decode", matcher_module.decode_audio))
    monkeypatch.setattr(matcher_module, "fingerprint", spy("fingerprint", matcher_module.fingerprint))
    monkeypatch.setattr(clip_engine.index, "lookup", spy("lookup", clip_engine.index.lookup))
    monkeypatch.setattr(matcher_module, "decide", spy("decide", matcher_module.decide))
    outcome = engine_process.recognize_clip_in_process(aac_clip_bytes(), 1.0)
    assert outcome["result"]["status"] == "MATCH"
    assert stages == ["decode", "fingerprint", "lookup", "decide"]
    assert set(outcome["timings_milliseconds"]) == {"decode", "fingerprint", "lookup", "align", "total"}


def test_a_clip_in_a_container_that_is_not_allowed_is_invalid_audio(clip_engine):
    for refused in (b"RIFF\x00\x10\x00\x00AVI LIST" + bytes(4096), b"\x89PNG\r\n\x1a\n" + bytes(4096), b"FLV\x01\x05" + bytes(4096), b""):
        assert engine_process.recognize_clip_in_process(refused, 1.0) == {"failure": "INVALID_AUDIO"}


def test_a_decode_that_runs_past_its_time_is_decode_timeout(clip_engine):
    """The decode deadline is checked as frames are decoded: past it, the clip is given up as DECODE_TIMEOUT."""
    assert engine_process.recognize_clip_in_process(aac_clip_bytes(), 1e-9) == {"failure": "DECODE_TIMEOUT"}


def test_the_index_gives_up_on_an_unreachable_database_within_its_connect_limit():
    """A pool process that opens its connection while Postgres is away fails in seconds with an error,
    rather than waiting on the network's own time-out (192.0.2.1 is a documentation address: nothing answers)."""
    import psycopg

    assert inspect.signature(PostgresIndex).parameters["connect_timeout_seconds"].default == 10
    started_at = time.monotonic()
    with pytest.raises(psycopg.OperationalError):
        PostgresIndex("postgresql://worker:not-a-password@192.0.2.1:5432/lookup", connect_timeout_seconds=2)
    assert time.monotonic() - started_at < 8


def test_the_lookup_is_given_800_milliseconds_and_a_cancelled_lookup_is_lookup_timeout(monkeypatch):
    import psycopg

    opened: list[dict] = []

    class RecordingIndex:
        def __init__(self, connection_string=None, **settings):
            opened.append({"connection_string": connection_string, **settings})

    monkeypatch.setattr(engine_process, "PostgresIndex", RecordingIndex)
    monkeypatch.setattr(engine_process, "_matcher", None)
    monkeypatch.setattr(engine_process, "_database_url", "postgresql://worker@database/lookup")
    worker_matcher = engine_process._matcher_for_this_process()
    assert opened == [{"connection_string": "postgresql://worker@database/lookup"}]
    assert inspect.signature(PostgresIndex).parameters["statement_timeout_milliseconds"].default == 800
    assert worker_matcher.thresholds == MatchThresholds()

    class CancelledLookup:
        def recognize_clip(self, clip, deadline_seconds=None):
            raise psycopg.errors.QueryCanceled("canceling statement due to statement timeout")

    monkeypatch.setattr(engine_process, "_matcher_for_this_process", lambda: CancelledLookup())
    assert engine_process.recognize_clip_in_process(b"clip", 1.0) == {"failure": "LOOKUP_TIMEOUT"}


# ---- what an ad must be ------------------------------------------------------------------------------


@pytest.mark.parametrize(("seconds", "accepted"), [(4.9, False), (5.0, True), (120.0, True), (120.1, False)])
def test_an_ad_must_be_5_to_120_seconds_long(seconds, accepted):
    outcome = engine_process.prepare_ad_audio_in_process(wav_bytes(seconds))
    if accepted:
        assert outcome["duration_milliseconds"] == round(seconds * 1000) and len(outcome["hashes"]) > 0
    else:
        assert outcome == {"refusal_reason": "audio_too_short" if seconds < 5 else "audio_too_long"}


def test_decoding_stops_a_little_past_the_longest_ad(monkeypatch):
    """A 130-second file is refused as too long once 121 seconds are decoded, not after decoding all of it."""
    decoded: list[str] = []
    real_decode = engine_process.decode_audio

    def watched_decode(*arguments, **keywords):
        assert keywords["maximum_seconds"] == 121.0
        try:
            return real_decode(*arguments, **keywords)
        except engine_process.DecodeError as refused:
            decoded.append(refused.code)
            raise

    monkeypatch.setattr(engine_process, "decode_audio", watched_decode)
    assert engine_process.prepare_ad_audio_in_process(wav_bytes(130.0)) == {"refusal_reason": "audio_too_long"}
    assert decoded == ["AUDIO_TOO_LONG"]


def test_the_length_is_checked_before_any_fingerprinting(monkeypatch):
    calls = []
    monkeypatch.setattr(engine_process, "fingerprint", lambda *arguments: calls.append(arguments))
    assert engine_process.prepare_ad_audio_in_process(wav_bytes(120.1)) == {"refusal_reason": "audio_too_long"}
    assert calls == []


def test_stereo_44_kilohertz_and_mono_16_kilohertz_copies_give_the_same_canonical_audio():
    """Both decode to one channel at the canonical rate, so they fingerprint alike."""
    mono = synthesize_ad(9, 6.0, sample_rate=SOURCE_SAMPLE_RATE)
    stereo = np.stack([mono, mono], axis=1)
    with tempfile.TemporaryDirectory() as folder:
        stereo_path, phone_path = Path(folder) / "stereo.wav", Path(folder) / "phone.wav"
        write_wav(stereo_path, stereo, SOURCE_SAMPLE_RATE)
        write_wav(phone_path, synthesize_ad(9, 6.0, sample_rate=16000), 16000)
        stereo_outcome = engine_process.prepare_ad_audio_in_process(stereo_path.read_bytes())
        phone_outcome = engine_process.prepare_ad_audio_in_process(phone_path.read_bytes())
    assert stereo_outcome["duration_milliseconds"] == phone_outcome["duration_milliseconds"] == 6000
    shared = np.intersect1d(stereo_outcome["hashes"], phone_outcome["hashes"]).size
    assert shared / min(len(stereo_outcome["hashes"]), len(phone_outcome["hashes"])) > 0.3


@pytest.mark.parametrize("file_bytes", [b"", b"this is not audio at all" * 40, b"\x89PNG\r\n\x1a\n" + b"\0" * 400])
def test_a_file_that_is_not_audio_is_refused_as_unreadable(file_bytes):
    assert engine_process.prepare_ad_audio_in_process(file_bytes) == {"refusal_reason": "audio_unreadable"}


def test_a_file_with_no_audio_stream_is_refused_as_such():
    import av

    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "video-only.mp4"
        with av.open(str(path), "w") as container:
            stream = container.add_stream("mpeg4", rate=10)
            stream.width, stream.height, stream.pix_fmt = 64, 48, "yuv420p"
            frame = av.VideoFrame.from_ndarray(np.zeros((48, 64, 3), dtype=np.uint8), format="rgb24")
            for packet in stream.encode(frame):
                container.mux(packet)
            for packet in stream.encode():
                container.mux(packet)
        assert engine_process.prepare_ad_audio_in_process(path.read_bytes()) == {"refusal_reason": "no_audio_in_file"}


# ---- the ingest handler ------------------------------------------------------------------------------


class FakeStore:
    def __init__(self, existing_asset_id=None, ad_changes=True, recording=None, version_recorded=True,
                 existing_asset_version=FINGERPRINT_VERSION) -> None:
        self.existing_asset_id = existing_asset_id
        self.existing_asset_version = existing_asset_version
        self.ad_changes = ad_changes
        self.recording = recording
        self.version_recorded = version_recorded
        self.recorded: list[tuple] = []
        self.stored: list[tuple] = []
        self.refingerprinted: list[tuple] = []

    def find_recording(self, audio_asset_number):
        return self.recording

    def store_refingerprinted_audio(self, audio_asset_number, prepared):
        self.refingerprinted.append((audio_asset_number, len(prepared["hashes"])))
        return self.version_recorded

    def find_audio_asset(self, content_sha256):
        if self.existing_asset_id is None:
            return None
        return ExistingAsset(self.existing_asset_id, 9, self.existing_asset_version)

    def record_result(self, ad_id, audio_asset_id, content_sha256, refusal_reason, request_id):
        self.recorded.append((ad_id, audio_asset_id, refusal_reason, request_id))
        return self.ad_changes

    def store_new_audio(self, ad_id, content_sha256, prepared, request_id):
        self.stored.append((ad_id, prepared["duration_milliseconds"], request_id))
        return StoreOutcome(ad_changed=self.ad_changes, linked_to_existing_audio=False)


def ingest_job(**changes) -> dict:
    return {"request_id": "r-ingest", "ad_id": "0192a6c4-0000-4000-8000-0000000000aa",
            "download_address": "http://127.0.0.1:39000/lookup-ad-uploads/key?X-Amz-Signature=s",
            "deadline_epoch_milliseconds": int(time.time() * 1000) + 60_000, "fingerprint_version": FINGERPRINT_VERSION, **changes}


PREPARED = {"duration_milliseconds": 30_000, "hashes": np.array([1, 2, 3]), "time_offset_frames": np.array([0, 1, 2]), "frame_count": 3}


def test_a_new_recording_is_fingerprinted_and_stored():
    store = FakeStore()
    pool = FakePool(PREPARED)
    result = asyncio.run(IngestJobHandler(pool, store, download=lambda address: b"RIFF audio")(ingest_job()))
    assert result == {"outcome": "READY", "is_linked_to_existing_audio": False}
    assert_matches_contract(result, "ingest-job-result.schema.json")
    assert store.stored == [("0192a6c4-0000-4000-8000-0000000000aa", 30_000, "r-ingest")]


def test_an_exact_copy_is_linked_without_decoding_or_fingerprinting():
    store = FakeStore(existing_asset_id="existing-asset")
    pool = FakePool()
    result = asyncio.run(IngestJobHandler(pool, store, download=lambda address: b"same bytes")(ingest_job()))
    assert result == {"outcome": "READY", "is_linked_to_existing_audio": True}
    assert pool.calls == [] and store.stored == []
    assert store.recorded == [("0192a6c4-0000-4000-8000-0000000000aa", "existing-asset", None, "r-ingest")]


def test_an_exact_copy_of_a_recording_on_an_older_version_is_fingerprinted_with_this_one_before_it_is_linked():
    store = FakeStore(existing_asset_id="existing-asset", existing_asset_version=FINGERPRINT_VERSION - 1)
    pool = FakePool(PREPARED)
    result = asyncio.run(IngestJobHandler(pool, store, download=lambda address: b"same bytes")(ingest_job()))
    assert result == {"outcome": "READY", "is_linked_to_existing_audio": True}
    assert [call[0] for call in pool.calls] == ["prepare_ad_audio_in_process"]
    assert store.refingerprinted == [(9, 3)] and store.stored == []
    assert store.recorded == [("0192a6c4-0000-4000-8000-0000000000aa", "existing-asset", None, "r-ingest")]


@pytest.mark.parametrize(("pool_answer", "reason"), [
    ({"refusal_reason": "audio_too_short"}, "audio_too_short"),
    (EngineTaskTimedOut(), "audio_took_too_long_to_read"),
])
def test_an_unusable_file_is_refused_with_its_reason(pool_answer, reason):
    store = FakeStore()
    result = asyncio.run(IngestJobHandler(FakePool(pool_answer), store, download=lambda address: b"bad")(ingest_job()))
    assert result == {"outcome": "REFUSED", "is_linked_to_existing_audio": False}
    assert store.recorded == [("0192a6c4-0000-4000-8000-0000000000aa", None, reason, "r-ingest")]


def test_a_file_over_20_megabytes_is_refused_unread():
    def too_large(address):
        raise UploadTooLarge()

    store = FakeStore()
    result = asyncio.run(IngestJobHandler(FakePool(), store, download=too_large)(ingest_job()))
    assert result["outcome"] == "REFUSED" and store.recorded[0][2] == "audio_unreadable"


def test_a_failed_download_is_retried_not_refused():
    def unreachable(address):
        raise OSError("connection reset")

    store = FakeStore()
    with pytest.raises(JobFailure) as failed:
        asyncio.run(IngestJobHandler(FakePool(), store, download=unreachable)(ingest_job()))
    assert str(failed.value) == "DOWNLOAD_FAILED"
    assert store.recorded == []


def test_an_expired_or_mismatched_ingest_job_does_no_work():
    store = FakeStore()
    expired = asyncio.run(IngestJobHandler(FakePool(), store, download=lambda a: 1 / 0)(ingest_job(deadline_epoch_milliseconds=1)))
    assert expired == {"outcome": "EXPIRED", "is_linked_to_existing_audio": False}
    with pytest.raises(JobFailure, match="FINGERPRINT_VERSION_MISMATCH"):
        asyncio.run(IngestJobHandler(FakePool(), store, download=lambda a: 1 / 0)(ingest_job(fingerprint_version=99)))
    assert store.recorded == []


# ---- re-fingerprint jobs (fingerprint version 2, ADR-001) ---------------------------------------------------------

def refingerprint_job(**changes) -> dict:
    return {"request_id": "r-refingerprint", "audio_asset_number": 7,
            "download_address": "http://127.0.0.1:39000/lookup-ad-uploads/key?X-Amz-Signature=s",
            "deadline_epoch_milliseconds": int(time.time() * 1000) + 60_000, "fingerprint_version": FINGERPRINT_VERSION, **changes}


UPLOADED = b"RIFF the uploaded ad"
ON_VERSION_ONE = StoredRecording(content_sha256=hashlib.sha256(UPLOADED).digest(), fingerprint_version=1)


def test_a_recording_on_an_older_version_is_fingerprinted_again_and_no_ad_is_touched():
    store, pool = FakeStore(recording=ON_VERSION_ONE), FakePool(PREPARED)
    result = asyncio.run(IngestJobHandler(pool, store, download=lambda address: UPLOADED)(refingerprint_job()))
    assert result == {"outcome": "REFINGERPRINTED", "hash_count": 3}
    assert_matches_contract(result, "refingerprint-job-result.schema.json")
    assert [call[0] for call in pool.calls] == ["prepare_ad_audio_in_process"]
    assert store.refingerprinted == [(7, 3)] and store.recorded == [] and store.stored == []


@pytest.mark.parametrize("recording", [None, StoredRecording(content_sha256=b"x" * 32, fingerprint_version=FINGERPRINT_VERSION)],
                         ids=["gone", "already-on-this-version"])
def test_a_recording_that_is_gone_or_already_current_is_skipped_without_a_download(recording):
    store = FakeStore(recording=recording)
    result = asyncio.run(IngestJobHandler(FakePool(), store, download=lambda address: 1 / 0)(refingerprint_job()))
    assert result == {"outcome": "SKIPPED", "hash_count": None}
    assert store.refingerprinted == []


def test_a_download_that_is_not_the_stored_recording_is_refused_before_decoding():
    store, pool = FakeStore(recording=ON_VERSION_ONE), FakePool()
    result = asyncio.run(IngestJobHandler(pool, store, download=lambda address: b"RIFF another file")(refingerprint_job()))
    assert result == {"outcome": "REFUSED", "hash_count": None}
    assert pool.calls == [] and store.refingerprinted == []


@pytest.mark.parametrize("pool_answer", [{"refusal_reason": "audio_too_long"}, EngineTaskTimedOut()])
def test_a_recording_that_can_no_longer_be_read_is_refused_and_left_as_it_is(pool_answer):
    store = FakeStore(recording=ON_VERSION_ONE)
    result = asyncio.run(IngestJobHandler(FakePool(pool_answer), store, download=lambda address: UPLOADED)(refingerprint_job()))
    assert result == {"outcome": "REFUSED", "hash_count": None}
    assert store.refingerprinted == [] and store.recorded == []


def test_a_second_job_that_lost_the_race_is_skipped():
    store = FakeStore(recording=ON_VERSION_ONE, version_recorded=False)
    result = asyncio.run(IngestJobHandler(FakePool(PREPARED), store, download=lambda address: UPLOADED)(refingerprint_job()))
    assert result == {"outcome": "SKIPPED", "hash_count": None}


def test_an_expired_mismatched_or_malformed_refingerprint_job_does_no_work():
    store = FakeStore(recording=ON_VERSION_ONE)
    handler = IngestJobHandler(FakePool(), store, download=lambda address: 1 / 0)
    assert asyncio.run(handler(refingerprint_job(deadline_epoch_milliseconds=1))) == {"outcome": "EXPIRED", "hash_count": None}
    with pytest.raises(JobFailure, match="FINGERPRINT_VERSION_MISMATCH"):
        asyncio.run(handler(refingerprint_job(fingerprint_version=FINGERPRINT_VERSION + 1)))
    for asset_number in (0, -3, "7", True, 7.0):
        with pytest.raises(JobFailure, match="INGEST_JOB_MALFORMED"):
            asyncio.run(handler(refingerprint_job(audio_asset_number=asset_number)))
    # A job carrying both an ad and a recording is neither kind.
    with pytest.raises(JobFailure, match="INGEST_JOB_MALFORMED"):
        asyncio.run(handler(refingerprint_job(ad_id="0192a6c4-0000-4000-8000-0000000000aa")))
    assert store.refingerprinted == []


def test_a_failed_refingerprint_download_is_retried():
    def unreachable(address):
        raise OSError("connection reset")

    with pytest.raises(JobFailure, match="DOWNLOAD_FAILED"):
        asyncio.run(IngestJobHandler(FakePool(), FakeStore(recording=ON_VERSION_ONE), download=unreachable)(refingerprint_job()))


def test_an_ad_that_no_longer_waits_is_skipped():
    result = asyncio.run(IngestJobHandler(FakePool(PREPARED), FakeStore(ad_changes=False), download=lambda a: b"x")(ingest_job()))
    assert result == {"outcome": "SKIPPED", "is_linked_to_existing_audio": False}
