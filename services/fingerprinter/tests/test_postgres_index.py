"""PostgresIndex must return exactly what MemoryIndex returns.

Needs a database: set LOOKUP_FINGERPRINT_TEST_DATABASE_URL (CI provides one; locally
`docker compose -f infra/docker-compose.yml up -d postgres` then
LOOKUP_FINGERPRINT_TEST_DATABASE_URL=postgresql://lookup:lookup_development_only@127.0.0.1:55432/lookup).
Without it these tests are skipped — CI must set the variable so they always run there.
"""

from __future__ import annotations

import os

import numpy as np
import pytest

from bench.synth import PHONE_RATE, SOURCE_RATE, phone_capture
from lookup_fingerprint import Matches, MemoryIndex, fingerprint

from .conftest import to_canonical

DATABASE_URL = os.environ.get("LOOKUP_FINGERPRINT_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="LOOKUP_FINGERPRINT_TEST_DATABASE_URL not set")


@pytest.fixture()
def postgres_index():
    from lookup_fingerprint import PostgresIndex

    index = PostgresIndex(DATABASE_URL, table="fingerprint_tests.hashes")
    index.ensure_schema()
    index.truncate()
    yield index
    index.truncate()
    index.close()


def _as_set(matches: Matches) -> set[tuple[int, int, int]]:
    return set(zip(matches.audio_asset_numbers.tolist(), matches.reference_time_offset_frames.tolist(),
                   matches.query_time_offset_frames.tolist()))


def test_postgres_lookup_equals_memory_lookup(postgres_index, ads, parameters):
    memory_index = MemoryIndex()
    for audio_asset_number, signal in ads.items():
        reference_fingerprint = fingerprint(to_canonical(signal, SOURCE_RATE, parameters), parameters)
        memory_index.add(audio_asset_number, reference_fingerprint)
        postgres_index.add(audio_asset_number, reference_fingerprint)
    clip = phone_capture(ads[2], 3.0, 8.0, signal_to_noise_decibels=15, random_generator=np.random.default_rng(9))
    query = fingerprint(to_canonical(clip, PHONE_RATE, parameters), parameters)
    assert len(memory_index.lookup(query)) > 0
    assert _as_set(postgres_index.lookup(query)) == _as_set(memory_index.lookup(query))


def test_postgres_reingest_is_idempotent(postgres_index, ads, parameters):
    reference_fingerprint = fingerprint(to_canonical(ads[1], SOURCE_RATE, parameters), parameters)
    postgres_index.add(1, reference_fingerprint)
    postgres_index.add(1, reference_fingerprint)
    postgres_index._hash_counts.clear()          # force a real COUNT(*)
    assert postgres_index.hash_count(1) == len(reference_fingerprint)
