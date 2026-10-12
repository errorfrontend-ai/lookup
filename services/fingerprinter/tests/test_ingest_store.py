"""The ingest worker's database work against the compose Postgres, connected as
`lookup_fingerprint_worker` (the role the worker uses), with test ads created by the setup user."""

from __future__ import annotations

import asyncio
import hashlib
import time
import uuid

import psycopg
import pytest

from lookup_fingerprint import FINGERPRINT_VERSION, hash_table_name
from workers import engine_process
from workers.engine_pool import EnginePool
from workers.ingest import IngestJobHandler
from workers.ingest_store import IngestStore

from .test_workers import ingest_job, refingerprint_job, wav_bytes

HASHES = hash_table_name()          # the current version's table
from .worker_support import fingerprint_worker_database_url, setup_database_url


@pytest.fixture()
def setup_connection():
    with psycopg.connect(setup_database_url(), autocommit=True) as connection:
        yield connection


@pytest.fixture()
def test_station(setup_connection):
    """An active station with one client; removed with everything created at it afterwards."""
    station_id, client_id = str(uuid.uuid4()), str(uuid.uuid4())
    created_assets: list[str] = []
    setup_connection.execute("INSERT INTO app.stations (id, name, frequency_label, status) VALUES (%s, %s, '98.1 FM', 'ACTIVE')",
                             (station_id, f"Ingest test {station_id[:8]}"))
    setup_connection.execute("INSERT INTO app.clients (id, station_id, name) VALUES (%s, %s, 'Brand A')", (client_id, station_id))

    def new_ad() -> str:
        ad_id = str(uuid.uuid4())
        setup_connection.execute(
            "INSERT INTO app.ads (id, station_id, client_id, title, status, upload_object_key, uploaded_at) "
            "VALUES (%s, %s, %s, 'Ingest test ad', 'PROCESSING', %s, now())",
            (ad_id, station_id, client_id, f"ad-uploads/{station_id}/{ad_id}/audio"))
        return ad_id

    yield {"station_id": station_id, "new_ad": new_ad, "created_assets": created_assets}
    asset_ids = [row[0] for row in setup_connection.execute(
        "SELECT DISTINCT audio_asset_id FROM app.ads WHERE station_id = %s AND audio_asset_id IS NOT NULL", (station_id,)).fetchall()]
    setup_connection.execute("DELETE FROM app.ads WHERE station_id = %s", (station_id,))
    setup_connection.execute("DELETE FROM app.audit_events WHERE station_id = %s", (station_id,))
    setup_connection.execute("DELETE FROM app.clients WHERE station_id = %s", (station_id,))
    setup_connection.execute("DELETE FROM app.stations WHERE id = %s", (station_id,))
    setup_connection.execute("DELETE FROM fingerprints.audio_assets WHERE id = ANY(%s)", (asset_ids + created_assets,))


@pytest.fixture()
def store():
    ingest_store = IngestStore(fingerprint_worker_database_url())
    yield ingest_store
    ingest_store.close()


def _ad(setup_connection, ad_id: str) -> dict:
    row = setup_connection.execute(
        "SELECT status, audio_asset_id, duration_milliseconds, processing_error_code, upload_content_sha256 FROM app.ads WHERE id = %s",
        (ad_id,)).fetchone()
    return dict(zip(("status", "audio_asset_id", "duration_milliseconds", "processing_error_code", "upload_content_sha256"), row))


def _hash_rows(setup_connection, audio_asset_id) -> int:
    return setup_connection.execute(
        f"SELECT count(*) FROM {HASHES} hash JOIN fingerprints.audio_assets asset "
        "ON asset.asset_number = hash.audio_asset_number WHERE asset.id = %s", (audio_asset_id,)).fetchone()[0]


def _rows_of_recording(setup_connection, file_bytes: bytes) -> tuple[int, int]:
    """(recordings with this file's SHA-256, their rows in the current hash table): this test's rows only, so other
    work on the shared database cannot change them."""
    return setup_connection.execute(
        f"SELECT count(*), coalesce(sum((SELECT count(*) FROM {HASHES} hash WHERE hash.audio_asset_number = asset.asset_number)), 0) "
        "FROM fingerprints.audio_assets asset WHERE asset.content_sha256 = %s", (hashlib.sha256(file_bytes).digest(),)).fetchone()


def _ingest(handler: IngestJobHandler, ad_id: str) -> dict:
    return asyncio.run(handler(ingest_job(ad_id=ad_id)))


@pytest.fixture(scope="module")
def pool():
    engine_pool = EnginePool(1, engine_process.start_ingest_process)
    yield engine_pool
    engine_pool.shutdown()


def test_a_new_recording_is_stored_with_all_its_hashes_and_the_ad_becomes_ready(test_station, store, pool, setup_connection):
    file_bytes = wav_bytes(12.0, seed=101)
    ad_id = test_station["new_ad"]()
    result = _ingest(IngestJobHandler(pool, store, download=lambda address: file_bytes), ad_id)

    assert result == {"outcome": "READY", "is_linked_to_existing_audio": False}
    ad = _ad(setup_connection, ad_id)
    assert ad["status"] == "READY" and ad["duration_milliseconds"] == 12_000 and ad["processing_error_code"] is None
    assert bytes(ad["upload_content_sha256"]) == hashlib.sha256(file_bytes).digest()
    asset = setup_connection.execute("SELECT hash_count, fingerprint_version, fingerprint_status FROM fingerprints.audio_assets WHERE id = %s",
                                     (ad["audio_asset_id"],)).fetchone()
    assert asset[1:] == (FINGERPRINT_VERSION, "READY")
    assert asset[0] == _hash_rows(setup_connection, ad["audio_asset_id"]) > 0


def test_the_same_file_again_links_to_the_first_recording_and_adds_no_hashes(test_station, store, pool, setup_connection):
    file_bytes = wav_bytes(10.0, seed=102)
    first_ad, second_ad = test_station["new_ad"](), test_station["new_ad"]()
    handler = IngestJobHandler(pool, store, download=lambda address: file_bytes)
    _ingest(handler, first_ad)
    rows_before = _rows_of_recording(setup_connection, file_bytes)

    assert _ingest(handler, second_ad) == {"outcome": "READY", "is_linked_to_existing_audio": True}
    assert _ad(setup_connection, second_ad)["audio_asset_id"] == _ad(setup_connection, first_ad)["audio_asset_id"]
    assert _ad(setup_connection, second_ad)["status"] == "READY"
    assert _rows_of_recording(setup_connection, file_bytes) == rows_before and rows_before[0] == 1


def test_running_a_job_twice_changes_nothing_the_second_time(test_station, store, pool, setup_connection):
    file_bytes = wav_bytes(8.0, seed=103)
    ad_id = test_station["new_ad"]()
    handler = IngestJobHandler(pool, store, download=lambda address: file_bytes)
    _ingest(handler, ad_id)
    rows_before = _rows_of_recording(setup_connection, file_bytes)
    assert _ingest(handler, ad_id) == {"outcome": "SKIPPED", "is_linked_to_existing_audio": True}
    assert _rows_of_recording(setup_connection, file_bytes) == rows_before and rows_before[0] == 1
    assert _ad(setup_connection, ad_id)["status"] == "READY"


def test_a_corrupt_file_fails_the_ad_with_a_known_reason_and_stores_nothing(test_station, store, pool, setup_connection):
    ad_id = test_station["new_ad"]()
    asset_count_before = setup_connection.execute("SELECT count(*) FROM fingerprints.audio_assets").fetchone()[0]
    result = _ingest(IngestJobHandler(pool, store, download=lambda address: b"RIFF" + b"\x13" * 3000), ad_id)
    assert result == {"outcome": "REFUSED", "is_linked_to_existing_audio": False}
    ad = _ad(setup_connection, ad_id)
    assert (ad["status"], ad["processing_error_code"], ad["audio_asset_id"]) == ("FAILED", "audio_unreadable", None)
    assert setup_connection.execute("SELECT count(*) FROM fingerprints.audio_assets").fetchone()[0] == asset_count_before


def test_a_new_recording_for_an_ad_that_stopped_waiting_leaves_nothing_behind(test_station, store, pool, setup_connection):
    file_bytes = wav_bytes(7.0, seed=104)
    ad_id = test_station["new_ad"]()
    setup_connection.execute("UPDATE app.ads SET archived_at = now() WHERE id = %s", (ad_id,))
    asset_count_before = setup_connection.execute("SELECT count(*) FROM fingerprints.audio_assets").fetchone()[0]
    assert _ingest(IngestJobHandler(pool, store, download=lambda address: file_bytes), ad_id) == {"outcome": "SKIPPED", "is_linked_to_existing_audio": False}
    assert setup_connection.execute("SELECT count(*) FROM fingerprints.audio_assets").fetchone()[0] == asset_count_before
    assert setup_connection.execute("SELECT count(*) FROM fingerprints.audio_assets WHERE content_sha256 = %s",
                                    (hashlib.sha256(file_bytes).digest(),)).fetchone()[0] == 0


def test_the_worker_role_cannot_read_or_change_station_data_directly():
    with psycopg.connect(fingerprint_worker_database_url()) as connection:
        for statement in ("SELECT 1 FROM app.ads LIMIT 1", "SELECT 1 FROM app.stations LIMIT 1", "UPDATE app.ads SET status = 'READY'"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with connection.transaction():
                    connection.execute(statement)


def test_two_ingests_at_once_each_commit_their_own_work(test_station, setup_connection):
    """Jobs run side by side in their own threads; each must commit its own transaction."""
    from concurrent.futures import ThreadPoolExecutor

    files = {test_station["new_ad"](): wav_bytes(9.0, seed=seed) for seed in (201, 202)}
    files[test_station["new_ad"]()] = wav_bytes(30.0, seed=203)

    def ingest(ad_id: str, file_bytes: bytes) -> dict:
        return asyncio.run(IngestJobHandler(_InlinePool(), IngestStore(fingerprint_worker_database_url()), download=lambda address: file_bytes)(ingest_job(ad_id=ad_id)))

    with ThreadPoolExecutor(max_workers=3) as threads:
        results = list(threads.map(lambda item: ingest(*item), files.items()))
    assert [result["outcome"] for result in results] == ["READY", "READY", "READY"]
    for ad_id in files:
        assert _ad(setup_connection, ad_id)["status"] == "READY"


def test_the_same_new_file_ingested_twice_at_once_is_stored_once_and_linked_once(test_station, setup_connection):
    """Both see no recording yet; the unique SHA-256 settles it: one stores, the other links."""
    from concurrent.futures import ThreadPoolExecutor

    file_bytes = wav_bytes(11.0, seed=204)
    prepared = engine_process.prepare_ad_audio_in_process(file_bytes)
    ad_ids = [test_station["new_ad"](), test_station["new_ad"]()]
    content_sha256 = hashlib.sha256(file_bytes).digest()

    def store(ad_id: str):
        return IngestStore(fingerprint_worker_database_url()).store_new_audio(ad_id, content_sha256, prepared, "race")

    with ThreadPoolExecutor(max_workers=2) as threads:
        outcomes = list(threads.map(store, ad_ids))
    assert sorted(outcome.linked_to_existing_audio for outcome in outcomes) == [False, True]
    assert all(outcome.ad_changed for outcome in outcomes)
    assets = setup_connection.execute("SELECT count(*) FROM fingerprints.audio_assets WHERE content_sha256 = %s", (content_sha256,)).fetchone()[0]
    assert assets == 1
    assert len({_ad(setup_connection, ad_id)["audio_asset_id"] for ad_id in ad_ids}) == 1


# ---- re-fingerprinting (fingerprint version 2, ADR-001) ---------------------------------------------------------

def _recording_on_version_one(setup_connection, store, pool, test_station, seed: int) -> tuple[str, int, bytes]:
    """An ad fingerprinted today, then turned back into a version 1 recording: its current-version hashes removed, two
    version 1 rows of its own, version 1 on the asset. Returns (ad id, asset number, the uploaded file)."""
    file_bytes = wav_bytes(10.0, seed=seed)
    ad_id = test_station["new_ad"]()
    _ingest(IngestJobHandler(pool, store, download=lambda address: file_bytes), ad_id)
    audio_asset_id = _ad(setup_connection, ad_id)["audio_asset_id"]
    asset_number = setup_connection.execute("SELECT asset_number FROM fingerprints.audio_assets WHERE id = %s", (audio_asset_id,)).fetchone()[0]
    setup_connection.execute(f"DELETE FROM {HASHES} WHERE audio_asset_number = %s", (asset_number,))
    setup_connection.execute("INSERT INTO fingerprints.hashes_version_1 (hash, audio_asset_number, time_offset_frames) VALUES (11, %s, 0), (12, %s, 1)",
                             (asset_number, asset_number))
    setup_connection.execute("UPDATE fingerprints.audio_assets SET fingerprint_version = 1, hash_count = 2 WHERE asset_number = %s", (asset_number,))
    return ad_id, asset_number, file_bytes


def _asset(setup_connection, asset_number: int) -> tuple:
    return setup_connection.execute(
        f"SELECT fingerprint_version, hash_count, (SELECT count(*) FROM {HASHES} WHERE audio_asset_number = %s), "
        "(SELECT count(*) FROM fingerprints.hashes_version_1 WHERE audio_asset_number = %s) FROM fingerprints.audio_assets WHERE asset_number = %s",
        (asset_number, asset_number, asset_number)).fetchone()


def _ad_and_its_history(setup_connection, ad_id: str) -> tuple:
    ad = setup_connection.execute("SELECT status, audio_asset_id, duration_milliseconds, updated_at FROM app.ads WHERE id = %s", (ad_id,)).fetchone()
    history = setup_connection.execute("SELECT count(*) FROM app.audit_events WHERE entity_id = %s", (ad_id,)).fetchone()[0]
    return ad, history


def test_a_recording_on_an_older_version_is_fingerprinted_again_and_no_ad_changes(test_station, store, pool, setup_connection):
    ad_id, asset_number, file_bytes = _recording_on_version_one(setup_connection, store, pool, test_station, seed=301)
    ad_before = _ad_and_its_history(setup_connection, ad_id)
    handler = IngestJobHandler(pool, store, download=lambda address: file_bytes)

    result = asyncio.run(handler(refingerprint_job(audio_asset_number=asset_number)))

    assert result["outcome"] == "REFINGERPRINTED" and result["hash_count"] > 0
    assert _asset(setup_connection, asset_number) == (FINGERPRINT_VERSION, result["hash_count"], result["hash_count"], 2)
    assert _ad_and_its_history(setup_connection, ad_id) == ad_before
    # Again: already on the version, so nothing is downloaded or written.
    again = IngestJobHandler(pool, store, download=lambda address: 1 / 0)
    assert asyncio.run(again(refingerprint_job(audio_asset_number=asset_number))) == {"outcome": "SKIPPED", "hash_count": None}
    assert _asset(setup_connection, asset_number) == (FINGERPRINT_VERSION, result["hash_count"], result["hash_count"], 2)


def test_a_download_that_is_not_the_recording_is_refused_and_changes_nothing(test_station, store, pool, setup_connection):
    _ad_id, asset_number, _file_bytes = _recording_on_version_one(setup_connection, store, pool, test_station, seed=302)
    handler = IngestJobHandler(pool, store, download=lambda address: wav_bytes(10.0, seed=303))
    assert asyncio.run(handler(refingerprint_job(audio_asset_number=asset_number))) == {"outcome": "REFUSED", "hash_count": None}
    assert _asset(setup_connection, asset_number) == (1, 2, 0, 2)


def test_two_jobs_for_one_recording_at_once_store_its_hashes_once(test_station, store, pool, setup_connection):
    """Both write; the version is recorded by one, and the other's rows are rolled back with it."""
    from concurrent.futures import ThreadPoolExecutor

    _ad_id, asset_number, file_bytes = _recording_on_version_one(setup_connection, store, pool, test_station, seed=304)
    prepared = engine_process.prepare_ad_audio_in_process(file_bytes)

    def refingerprint(_attempt: int) -> bool:
        return IngestStore(fingerprint_worker_database_url()).store_refingerprinted_audio(asset_number, prepared)

    # Hold the recording's row, so both jobs have deleted and are writing their hashes (the foreign key waits on the
    # row) before either can record the version: they truly overlap.
    with psycopg.connect(setup_database_url()) as holder:
        holder.execute("SELECT 1 FROM fingerprints.audio_assets WHERE asset_number = %s FOR UPDATE", (asset_number,))
        with ThreadPoolExecutor(max_workers=2) as threads:
            running = [threads.submit(refingerprint, attempt) for attempt in range(2)]
            for _ in range(200):
                waiting = setup_connection.execute(
                    "SELECT count(*) FROM pg_stat_activity WHERE usename = 'lookup_fingerprint_worker' AND wait_event_type = 'Lock' AND query ILIKE 'COPY%%'"
                ).fetchone()[0]
                if waiting >= 2:
                    break
                time.sleep(0.05)
            assert waiting >= 2, "both jobs should be waiting on the recording's row"
            holder.commit()
            recorded = [job.result(timeout=30) for job in running]
    assert sorted(recorded) == [False, True]
    assert _asset(setup_connection, asset_number) == (FINGERPRINT_VERSION, len(prepared["hashes"]), len(prepared["hashes"]), 2)


def test_an_exact_copy_of_a_version_one_recording_gets_the_current_versions_hashes_and_both_ads_are_recognisable(test_station, store, pool, setup_connection):
    first_ad, asset_number, file_bytes = _recording_on_version_one(setup_connection, store, pool, test_station, seed=306)
    second_ad = test_station["new_ad"]()

    assert _ingest(IngestJobHandler(pool, store, download=lambda address: file_bytes), second_ad) == {"outcome": "READY", "is_linked_to_existing_audio": True}

    version, hash_count, current_rows, version_one_rows = _asset(setup_connection, asset_number)
    assert (version, version_one_rows) == (FINGERPRINT_VERSION, 2) and hash_count == current_rows > 0
    assert _ad(setup_connection, second_ad)["audio_asset_id"] == _ad(setup_connection, first_ad)["audio_asset_id"]


def test_an_ingest_that_meets_a_version_one_recording_on_insert_gives_it_the_current_versions_hashes(test_station, store, pool, setup_connection):
    """The race path: the recording appeared after this job looked for it, stored by a worker on an older version."""
    _first_ad, asset_number, file_bytes = _recording_on_version_one(setup_connection, store, pool, test_station, seed=307)
    prepared = engine_process.prepare_ad_audio_in_process(file_bytes)
    outcome = store.store_new_audio(test_station["new_ad"](), hashlib.sha256(file_bytes).digest(), prepared, "race")

    assert outcome.linked_to_existing_audio and outcome.ad_changed
    assert _asset(setup_connection, asset_number) == (FINGERPRINT_VERSION, len(prepared["hashes"]), len(prepared["hashes"]), 2)


def test_re_fingerprinting_a_recording_that_is_gone_writes_nothing_and_says_so(store, setup_connection):
    prepared = engine_process.prepare_ad_audio_in_process(wav_bytes(6.0, seed=308))
    assert store.store_refingerprinted_audio(2_000_000_000, prepared) is False
    assert setup_connection.execute(f"SELECT count(*) FROM {HASHES} WHERE audio_asset_number = 2000000000").fetchone()[0] == 0


def test_the_new_version_is_recorded_only_through_the_function_and_only_for_a_version_with_a_table(test_station, store, pool, setup_connection):
    _ad_id, asset_number, _file_bytes = _recording_on_version_one(setup_connection, store, pool, test_station, seed=305)
    with psycopg.connect(fingerprint_worker_database_url()) as connection:
        with pytest.raises(psycopg.errors.InsufficientPrivilege), connection.transaction():
            connection.execute("UPDATE fingerprints.audio_assets SET fingerprint_version = 2 WHERE asset_number = %s", (asset_number,))
        with pytest.raises(psycopg.errors.InvalidParameterValue), connection.transaction():
            connection.execute("SELECT fingerprints.record_asset_refingerprinted(%s::integer, 9::smallint)", (asset_number,))
    assert _asset(setup_connection, asset_number) == (1, 2, 0, 2)


class _InlinePool:
    """Runs the engine in the calling thread, for tests where the process pool is not the point."""

    async def run(self, function, *arguments, timeout_seconds):
        return function(*arguments)
