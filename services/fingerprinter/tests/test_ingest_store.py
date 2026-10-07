"""The ingest worker's database work against the compose Postgres, connected as
`lookup_fingerprint_worker` (the role the worker uses), with test ads created by the setup user."""

from __future__ import annotations

import asyncio
import hashlib
import uuid

import psycopg
import pytest

from workers import engine_process
from workers.engine_pool import EnginePool
from workers.ingest import IngestJobHandler
from workers.ingest_store import IngestStore

from .test_workers import ingest_job, wav_bytes
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
        "SELECT count(*) FROM fingerprints.hashes_version_1 hash JOIN fingerprints.audio_assets asset "
        "ON asset.asset_number = hash.audio_asset_number WHERE asset.id = %s", (audio_asset_id,)).fetchone()[0]


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
    assert asset[1:] == (1, "READY")
    assert asset[0] == _hash_rows(setup_connection, ad["audio_asset_id"]) > 0


def test_the_same_file_again_links_to_the_first_recording_and_adds_no_hashes(test_station, store, pool, setup_connection):
    file_bytes = wav_bytes(10.0, seed=102)
    first_ad, second_ad = test_station["new_ad"](), test_station["new_ad"]()
    handler = IngestJobHandler(pool, store, download=lambda address: file_bytes)
    _ingest(handler, first_ad)
    asset_count_before = setup_connection.execute("SELECT count(*) FROM fingerprints.audio_assets").fetchone()[0]
    hash_count_before = setup_connection.execute("SELECT count(*) FROM fingerprints.hashes_version_1").fetchone()[0]

    assert _ingest(handler, second_ad) == {"outcome": "READY", "is_linked_to_existing_audio": True}
    assert _ad(setup_connection, second_ad)["audio_asset_id"] == _ad(setup_connection, first_ad)["audio_asset_id"]
    assert _ad(setup_connection, second_ad)["status"] == "READY"
    assert setup_connection.execute("SELECT count(*) FROM fingerprints.audio_assets").fetchone()[0] == asset_count_before
    assert setup_connection.execute("SELECT count(*) FROM fingerprints.hashes_version_1").fetchone()[0] == hash_count_before


def test_running_a_job_twice_changes_nothing_the_second_time(test_station, store, pool, setup_connection):
    file_bytes = wav_bytes(8.0, seed=103)
    ad_id = test_station["new_ad"]()
    handler = IngestJobHandler(pool, store, download=lambda address: file_bytes)
    _ingest(handler, ad_id)
    counts = setup_connection.execute("SELECT (SELECT count(*) FROM fingerprints.audio_assets), (SELECT count(*) FROM fingerprints.hashes_version_1)").fetchone()
    assert _ingest(handler, ad_id) == {"outcome": "SKIPPED", "is_linked_to_existing_audio": True}
    assert setup_connection.execute("SELECT (SELECT count(*) FROM fingerprints.audio_assets), (SELECT count(*) FROM fingerprints.hashes_version_1)").fetchone() == counts
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


class _InlinePool:
    """Runs the engine in the calling thread, for tests where the process pool is not the point."""

    async def run(self, function, *arguments, timeout_seconds):
        return function(*arguments)
