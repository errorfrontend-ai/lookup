"""The ingest worker's database work, as `lookup_fingerprint_worker`: it reads and writes only the
`fingerprints` schema and changes an ad only through `fingerprints.record_ad_ingest_result`.

A new recording's asset row, all its hashes and the ad's outcome are written in one transaction, so a
failure part-way leaves nothing behind and a retry starts clean. Two ingests of the same new file are
settled by the unique SHA-256: the second links to the first's asset. An exact copy of a recording still on an
older fingerprint version is fingerprinted with the current one before it is linked, or the ad could never be
recognised (the recognize worker reads only the current version's table). Re-fingerprinting a stored recording
writes its hashes for the current version and records that version through
`fingerprints.record_asset_refingerprinted`, also in one transaction, and touches no ad.

Every operation opens its own connection. Jobs run side by side (WORKER_CONCURRENCY), each in its own
thread, and one connection shared between them would nest one job's transaction inside another's.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import psycopg

from lookup_fingerprint import FINGERPRINT_VERSION, Fingerprint, PostgresIndex

from .fingerprint_store_check import check_fingerprint_store


@dataclass(frozen=True)
class StoreOutcome:
    ad_changed: bool
    linked_to_existing_audio: bool


@dataclass(frozen=True)
class StoredRecording:
    content_sha256: bytes
    fingerprint_version: int


@dataclass(frozen=True)
class ExistingAsset:
    """A recording already stored with the same SHA-256 as an upload."""
    audio_asset_id: str
    asset_number: int
    fingerprint_version: int


class _AdNoLongerWaiting(Exception):
    """Raised inside the transaction to undo a new asset when its ad no longer waits for it."""


class _AlreadyOnThisVersion(Exception):
    """Raised inside the transaction to undo re-written hashes when another job recorded the version first."""


def _fingerprint_from(prepared: dict[str, Any]) -> Fingerprint:
    return Fingerprint(hashes=np.asarray(prepared["hashes"], dtype=np.int64),
                       time_offset_frames=np.asarray(prepared["time_offset_frames"], dtype=np.int32),
                       frame_count=int(prepared["frame_count"]))


class IngestStore:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def _connect(self) -> psycopg.Connection:
        return psycopg.connect(self._database_url, autocommit=False, connect_timeout=10)

    def close(self) -> None:
        """Nothing is held open between operations."""

    def check_fingerprint_store(self) -> None:
        """At start-up: the database answers and holds this version's hash table and the re-fingerprint function."""
        with self._connect() as connection, connection.transaction():
            check_fingerprint_store(connection, needs_refingerprint_function=True)

    def find_audio_asset(self, content_sha256: bytes) -> ExistingAsset | None:
        with self._connect() as connection, connection.transaction():
            row = connection.execute("SELECT id, asset_number, fingerprint_version FROM fingerprints.audio_assets WHERE content_sha256 = %s",
                                     (content_sha256,)).fetchone()
        return ExistingAsset(str(row[0]), int(row[1]), int(row[2])) if row else None

    def record_result(self, ad_id: str, audio_asset_id: str | None, content_sha256: bytes | None, refusal_reason: str | None,
                      request_id: str) -> bool:
        with self._connect() as connection, connection.transaction():
            return self._record(connection, ad_id, audio_asset_id, content_sha256, refusal_reason, request_id)

    @staticmethod
    def _record(connection: psycopg.Connection, ad_id: str, audio_asset_id: str | None, content_sha256: bytes | None,
                refusal_reason: str | None, request_id: str) -> bool:
        row = connection.execute("SELECT fingerprints.record_ad_ingest_result(%s, %s, %s, %s, %s)",
                                 (ad_id, audio_asset_id, content_sha256, refusal_reason, request_id)).fetchone()
        return bool(row[0])

    def store_new_audio(self, ad_id: str, content_sha256: bytes, prepared: dict[str, Any], request_id: str) -> StoreOutcome:
        ad_fingerprint = _fingerprint_from(prepared)
        with self._connect() as connection:
            try:
                with connection.transaction():
                    inserted = connection.execute(
                        """INSERT INTO fingerprints.audio_assets (content_sha256, duration_milliseconds, fingerprint_version, hash_count)
                           VALUES (%s, %s, %s, %s) ON CONFLICT (content_sha256) DO NOTHING RETURNING id, asset_number""",
                        (content_sha256, prepared["duration_milliseconds"], FINGERPRINT_VERSION, len(ad_fingerprint)),
                    ).fetchone()
                    if inserted is None:
                        # Another ingest of the same file finished first: link to its recording, first giving it this
                        # version's hashes if a worker on an older version stored it.
                        existing_id, existing_number, existing_version = connection.execute(
                            "SELECT id, asset_number, fingerprint_version FROM fingerprints.audio_assets WHERE content_sha256 = %s",
                            (content_sha256,)).fetchone()
                        if existing_version < FINGERPRINT_VERSION:
                            try:
                                with connection.transaction():   # a savepoint: undone alone if another job got there first
                                    PostgresIndex(connection=connection).add(existing_number, ad_fingerprint)
                                    recorded = connection.execute("SELECT fingerprints.record_asset_refingerprinted(%s::integer, %s::smallint)",
                                                                  (existing_number, FINGERPRINT_VERSION)).fetchone()
                                    if not recorded[0]:
                                        raise _AlreadyOnThisVersion()
                            except _AlreadyOnThisVersion:
                                pass   # its hashes stand; ours would have doubled them
                        changed = self._record(connection, ad_id, str(existing_id), content_sha256, None, request_id)
                        return StoreOutcome(changed, linked_to_existing_audio=True)
                    audio_asset_id, asset_number = inserted
                    PostgresIndex(connection=connection).add(asset_number, ad_fingerprint)
                    if not self._record(connection, ad_id, str(audio_asset_id), content_sha256, None, request_id):
                        raise _AdNoLongerWaiting()
                    return StoreOutcome(ad_changed=True, linked_to_existing_audio=False)
            except _AdNoLongerWaiting:
                return StoreOutcome(ad_changed=False, linked_to_existing_audio=False)

    def find_recording(self, audio_asset_number: int) -> StoredRecording | None:
        with self._connect() as connection, connection.transaction():
            row = connection.execute("SELECT content_sha256, fingerprint_version FROM fingerprints.audio_assets WHERE asset_number = %s",
                                     (audio_asset_number,)).fetchone()
        return StoredRecording(bytes(row[0]), int(row[1])) if row else None

    def store_refingerprinted_audio(self, audio_asset_number: int, prepared: dict[str, Any]) -> bool:
        """The recording's hashes for the current version, then the version itself, in one transaction. False, with
        nothing written, when the recording was already on this version (another job got there first) or is gone (its
        hashes then break the foreign key to it, which undoes the transaction)."""
        recording_fingerprint = _fingerprint_from(prepared)
        with self._connect() as connection:
            try:
                with connection.transaction():
                    PostgresIndex(connection=connection).add(audio_asset_number, recording_fingerprint)
                    recorded = connection.execute("SELECT fingerprints.record_asset_refingerprinted(%s::integer, %s::smallint)",
                                                  (audio_asset_number, FINGERPRINT_VERSION)).fetchone()
                    if not recorded[0]:
                        raise _AlreadyOnThisVersion()
                    return True
            except (_AlreadyOnThisVersion, psycopg.errors.ForeignKeyViolation):
                return False
