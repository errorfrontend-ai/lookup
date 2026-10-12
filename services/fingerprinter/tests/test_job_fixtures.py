"""S3-STRUCTURE-06: the worker tests read the same job fixtures as the contracts' own tests
(packages/contracts/fixtures/recognition, checked there with zod and the JSON Schemas). Every valid job
and result fits the contract here too, every invalid one is refused, the workers read exactly the
fields of a valid job, and what they answer is one of the shared results.
"""

from __future__ import annotations

import asyncio
import base64

import pytest

from workers import ingest, recognize
from workers.ingest import IngestJobHandler
from workers.recognize import RecognizeJobHandler

from .test_workers import ON_VERSION_ONE, PREPARED, UPLOADED, FakePool, FakeStore
from .worker_support import assert_matches_contract, contract_fixtures

# Fixture folder → the field holding the value in each file, and the contract's JSON Schema.
FIXTURE_FOLDERS = {
    "recognize-job": ("job", "recognize-job-data.schema.json"),
    "recognize-job-result": ("result", "recognize-job-result.schema.json"),
    "ingest-job": ("job", "ingest-job-data.schema.json"),
    "ingest-job-result": ("result", "ingest-job-result.schema.json"),
    "refingerprint-job": ("job", "refingerprint-job-data.schema.json"),
    "refingerprint-job-result": ("result", "refingerprint-job-result.schema.json"),
}


def _shared(folder: str, validity: str) -> dict[str, dict]:
    field = FIXTURE_FOLDERS[folder][0]
    return {name: fixture[field] for name, fixture in contract_fixtures(f"recognition/{folder}/{validity}")}


def _cases(validity: str) -> list:
    return [pytest.param(folder, value, id=f"{folder}/{name}")
            for folder in FIXTURE_FOLDERS for name, value in _shared(folder, validity).items()]


def _clock_at(seconds: float):
    return lambda: seconds


def test_every_job_shape_has_shared_fixtures_to_accept_and_to_refuse():
    for folder in FIXTURE_FOLDERS:
        assert len(_shared(folder, "valid")) >= 3 and len(_shared(folder, "invalid")) >= 5, folder


@pytest.mark.parametrize(("folder", "value"), _cases("valid"))
def test_a_valid_shared_fixture_fits_its_contract(folder, value):
    assert_matches_contract(value, FIXTURE_FOLDERS[folder][1])


@pytest.mark.parametrize(("folder", "value"), _cases("invalid"))
def test_an_invalid_shared_fixture_is_refused_by_its_contract(folder, value):
    with pytest.raises(AssertionError):
        assert_matches_contract(value, FIXTURE_FOLDERS[folder][1])


def test_the_workers_read_exactly_the_fields_of_a_valid_shared_job():
    assert [set(job) for job in _shared("recognize-job", "valid").values()] == [set(recognize.JOB_FIELDS)] * 3
    assert [set(job) for job in _shared("ingest-job", "valid").values()] == [set(ingest.JOB_FIELDS)] * 3
    assert [set(job) for job in _shared("refingerprint-job", "valid").values()] == [set(ingest.REFINGERPRINT_JOB_FIELDS)] * 3


def test_the_recognize_worker_answers_a_shared_job_with_a_shared_result():
    results = _shared("recognize-job-result", "valid")
    for name, job in _shared("recognize-job", "valid").items():
        deadline_seconds = job["deadline_epoch_milliseconds"] / 1000
        late = asyncio.run(RecognizeJobHandler(FakePool(), clock=_clock_at(deadline_seconds + 1))(job))
        assert late == results["expired"], name

        pool = FakePool({"result": results["match"], "timings_milliseconds": {"total": 9.0}})
        in_time = asyncio.run(RecognizeJobHandler(pool, clock=_clock_at(deadline_seconds - 60))(job))
        assert in_time == results["match"], name
        (_function_name, (clip, _decode_seconds), _timeout_seconds), = pool.calls
        assert clip == base64.b64decode(job["audio_base64"]), name


def test_the_ingest_worker_answers_a_shared_job_with_a_shared_result():
    results = _shared("ingest-job-result", "valid")
    for name, job in _shared("ingest-job", "valid").items():
        deadline_seconds = job["deadline_epoch_milliseconds"] / 1000
        in_time = _clock_at(deadline_seconds - 60)

        def answer(pool, store, clock=in_time) -> dict:
            return asyncio.run(IngestJobHandler(pool, store, download=lambda address: b"RIFF the uploaded ad", clock=clock)(job))

        assert answer(FakePool(), FakeStore(), clock=_clock_at(deadline_seconds + 1)) == results["expired"], name
        assert answer(FakePool(PREPARED), FakeStore()) == results["ready"], name
        assert answer(FakePool(), FakeStore(existing_asset_id="an-existing-asset")) == results["ready-linked-to-existing-audio"], name
        assert answer(FakePool({"refusal_reason": "audio_too_short"}), FakeStore()) == results["refused"], name
        assert answer(FakePool(PREPARED), FakeStore(ad_changes=False)) == results["skipped"], name


def test_the_ingest_worker_answers_a_shared_refingerprint_job_with_a_shared_result():
    results = _shared("refingerprint-job-result", "valid")
    for name, job in _shared("refingerprint-job", "valid").items():
        deadline_seconds = job["deadline_epoch_milliseconds"] / 1000
        in_time = _clock_at(deadline_seconds - 60)

        def answer(pool, store, download=lambda address: UPLOADED, clock=in_time) -> dict:
            return asyncio.run(IngestJobHandler(pool, store, download=download, clock=clock)(job))

        assert answer(FakePool(), FakeStore(recording=ON_VERSION_ONE), clock=_clock_at(deadline_seconds + 1)) == results["expired"], name
        assert answer(FakePool(PREPARED), FakeStore(recording=ON_VERSION_ONE)) == results["refingerprinted"], name
        assert answer(FakePool(), FakeStore(recording=None)) == results["skipped"], name
        assert answer(FakePool(), FakeStore(recording=ON_VERSION_ONE), download=lambda address: b"another file") == results["refused"], name
