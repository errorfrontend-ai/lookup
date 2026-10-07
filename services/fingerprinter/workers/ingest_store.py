"""The ingest worker's database work, as `lookup_fingerprint_worker`: it reads and writes only the
`fingerprints` schema and changes an ad only through `fingerprints.record_ad_ingest_result`.

A new recording's asset row, all its hashes and the ad's outcome are written in one transaction, so a
failure part-way leaves nothing behind and a retry starts clean. Two ingests of the same new file are
settled by the unique SHA-256: the second links to the first's asset.

Every operation opens its own connection. Jobs run side by side (WORKER_CONCURRENCY), each in its own
thread, and one connection shared between them would nest one job's transaction inside another's.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import psycopg

from lookup_fingerprint import FINGERPRINT_VERSION, Fingerprint, PostgresIndex


@dataclass(frozen=True)
class StoreOutcome:
    ad_changed: bool
    linked_to_existing_audio: bool


class _AdNoLongerWaiting(Exception):
    """Raised inside the transaction to undo a new asset when its ad no longer waits for it."""


class IngestStore:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def _connect(self) -> psycopg.Connection:
        return psycopg.connect(self._database_url, autocommit=False, connect_timeout=10)

    def close(self) -> None:
        """Nothing is held open between operations."""

    def find_audio_asset(self, content_sha256: bytes) -> str | None:
        with self._connect() as connection, connection.transaction():
            row = connection.execute("SELECT id FROM fingerprints.audio_assets WHERE content_sha256 = %s", (content_sha256,)).fetchone()
        return str(row[0]) if row else None

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
        ad_fingerprint = Fingerprint(hashes=np.asarray(prepared["hashes"], dtype=np.int64),
                                     time_offset_frames=np.asarray(prepared["time_offset_frames"], dtype=np.int32),
                                     frame_count=int(prepared["frame_count"]))
        with self._connect() as connection:
            try:
                with connection.transaction():
                    inserted = connection.execute(
                        """INSERT INTO fingerprints.audio_assets (content_sha256, duration_milliseconds, fingerprint_version, hash_count)
                           VALUES (%s, %s, %s, %s) ON CONFLICT (content_sha256) DO NOTHING RETURNING id, asset_number""",
                        (content_sha256, prepared["duration_milliseconds"], FINGERPRINT_VERSION, len(ad_fingerprint)),
                    ).fetchone()
                    if inserted is None:
                        # Another ingest of the same file finished first: link to its recording.
                        existing = connection.execute(
                            "SELECT id FROM fingerprints.audio_assets WHERE content_sha256 = %s", (content_sha256,)).fetchone()
                        changed = self._record(connection, ad_id, str(existing[0]), content_sha256, None, request_id)
                        return StoreOutcome(changed, linked_to_existing_audio=True)
                    audio_asset_id, asset_number = inserted
                    PostgresIndex(connection=connection).add(asset_number, ad_fingerprint)
                    if not self._record(connection, ad_id, str(audio_asset_id), content_sha256, None, request_id):
                        raise _AdNoLongerWaiting()
                    return StoreOutcome(ad_changed=True, linked_to_existing_audio=False)
            except _AdNoLongerWaiting:
                return StoreOutcome(ad_changed=False, linked_to_existing_audio=False)
