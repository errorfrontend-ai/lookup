"""PostgresIndex must return exactly what MemoryIndex returns.

Needs the compose database (`docker compose -f infra/docker-compose.yml up -d postgres`). The
address defaults to the development database and can be changed with
LOOKUP_FINGERPRINT_TEST_DATABASE_URL. These tests never skip: with no database they fail.
"""

from __future__ import annotations

import os

import numpy as np
import pytest

from bench.synthetic_audio import PHONE_SAMPLE_RATE, SOURCE_SAMPLE_RATE, simulate_phone_capture
from lookup_fingerprint import Matches, MemoryIndex, fingerprint

from .conftest import to_canonical

DATABASE_URL = os.environ.get(
    "LOOKUP_FINGERPRINT_TEST_DATABASE_URL", "postgresql://lookup:lookup_development_only@127.0.0.1:55432/lookup")


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
        reference_fingerprint = fingerprint(to_canonical(signal, SOURCE_SAMPLE_RATE, parameters), parameters)
        memory_index.add(audio_asset_number, reference_fingerprint)
        postgres_index.add(audio_asset_number, reference_fingerprint)
    clip = simulate_phone_capture(ads[2], 3.0, 8.0, signal_to_noise_decibels=15,
                                  random_generator=np.random.default_rng(9))
    query = fingerprint(to_canonical(clip, PHONE_SAMPLE_RATE, parameters), parameters)
    assert len(memory_index.lookup(query)) > 0
    assert _as_set(postgres_index.lookup(query)) == _as_set(memory_index.lookup(query))


def test_postgres_reingest_is_idempotent(postgres_index, ads, parameters):
    reference_fingerprint = fingerprint(to_canonical(ads[1], SOURCE_SAMPLE_RATE, parameters), parameters)
    postgres_index.add(1, reference_fingerprint)
    postgres_index.add(1, reference_fingerprint)
    postgres_index._hash_counts.clear()          # force a real COUNT(*)
    assert postgres_index.hash_count(1) == len(reference_fingerprint)


def test_lookup_is_one_query_with_the_hashes_as_a_bound_parameter(postgres_index, ads, parameters, monkeypatch):
    import psycopg

    reference_fingerprint = fingerprint(to_canonical(ads[4], SOURCE_SAMPLE_RATE, parameters), parameters)
    postgres_index.add(4, reference_fingerprint)
    statements: list[tuple[str, object]] = []
    real_execute = psycopg.Cursor.execute

    def recording_execute(cursor, query, params=None, **options):
        text = query if isinstance(query, str) else query.as_string(cursor.connection)
        statements.append((text, params))
        return real_execute(cursor, query, params, **options)

    monkeypatch.setattr(psycopg.Cursor, "execute", recording_execute)
    postgres_index.lookup(reference_fingerprint)

    selects = [(text, params) for text, params in statements if text.lstrip().upper().startswith("SELECT")]
    assert len(selects) == 1
    select_text, select_parameters = selects[0]
    assert "= ANY(%s::bigint[])" in select_text
    assert len(select_parameters[0]) == len(np.unique(reference_fingerprint.hashes))
    assert str(int(reference_fingerprint.hashes[0])) not in select_text


def test_the_lookup_is_cancelled_at_its_statement_timeout(ads, parameters):
    """A lookup held up by a lock is cancelled at the timeout (800 ms in production; 300 ms here)."""
    import time

    import psycopg
    from lookup_fingerprint import PostgresIndex

    index = PostgresIndex(DATABASE_URL, table="fingerprint_tests.hashes", statement_timeout_milliseconds=300)
    index.ensure_schema()
    blocker = psycopg.connect(DATABASE_URL, autocommit=False)
    try:
        blocker.execute("LOCK TABLE fingerprint_tests.hashes IN ACCESS EXCLUSIVE MODE")
        query = fingerprint(to_canonical(ads[1], SOURCE_SAMPLE_RATE, parameters)[: parameters.sample_rate * 3], parameters)
        started_at = time.perf_counter()
        with pytest.raises(psycopg.errors.QueryCanceled):
            index.lookup(query)
        assert time.perf_counter() - started_at < 2.0
    finally:
        blocker.rollback()
        blocker.close()
        index.close()


def test_the_hash_column_is_bigint(postgres_index):
    import psycopg

    with psycopg.connect(DATABASE_URL) as connection:
        column_type = connection.execute(
            "SELECT data_type FROM information_schema.columns "
            "WHERE table_schema = 'fingerprints' AND table_name = 'hashes_version_1' AND column_name = 'hash'"
        ).fetchone()
    assert column_type == ("bigint",)


def test_an_index_can_write_inside_its_callers_transaction(ads, parameters):
    """The ingest worker writes an asset, its hashes and the ad's outcome in one transaction: a
    failure after the hashes leaves none of them behind."""
    import psycopg
    from lookup_fingerprint import PostgresIndex

    reference_fingerprint = fingerprint(to_canonical(ads[5], SOURCE_SAMPLE_RATE, parameters), parameters)
    with psycopg.connect(DATABASE_URL, autocommit=False) as connection:
        index = PostgresIndex(table="fingerprint_tests.hashes", connection=connection)
        index.ensure_schema()
        index.truncate()
        with pytest.raises(RuntimeError):
            with connection.transaction():
                index.add(5, reference_fingerprint)
                raise RuntimeError("the outcome could not be recorded")
        count = connection.execute("SELECT count(*) FROM fingerprint_tests.hashes WHERE audio_asset_number = 5").fetchone()
        assert count == (0,)
        with connection.transaction():
            index.add(5, reference_fingerprint)
        count = connection.execute("SELECT count(*) FROM fingerprint_tests.hashes WHERE audio_asset_number = 5").fetchone()
        assert count == (len(reference_fingerprint),)
        index.truncate()
