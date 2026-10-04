"""Landmark indexes. Phase 0 compares the in-memory index against Postgres (plan: "Postgres vs
in-memory index, decided by Phase 0 data"); both expose the same add/lookup surface."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import numpy as np

from .fingerprint import Fingerprint


@dataclass(frozen=True)
class Matches:
    audio_asset_numbers: np.ndarray            # int64 — asset each hit belongs to
    reference_time_offset_frames: np.ndarray   # int64 — landmark frame in the reference
    query_time_offset_frames: np.ndarray       # int64 — landmark frame in the query

    def __len__(self) -> int:
        return int(self.audio_asset_numbers.size)

    @staticmethod
    def empty() -> "Matches":
        empty_array = np.empty(0, np.int64)
        return Matches(empty_array, empty_array, empty_array)


class LandmarkIndex(Protocol):
    def add(self, audio_asset_number: int, fingerprint: Fingerprint) -> None: ...
    def lookup(self, fingerprint: Fingerprint) -> Matches: ...
    def hash_count(self, audio_asset_number: int) -> int: ...


def _expand_ranges(range_starts: np.ndarray, range_ends: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """For each range i, emit indices range_starts[i]..range_ends[i]-1.

    Returns (source_positions, flat_indices): which range each emitted index came from, and the index.
    """
    range_lengths = range_ends - range_starts
    total = int(range_lengths.sum())
    if total == 0:
        return np.empty(0, np.int64), np.empty(0, np.int64)
    source_positions = np.repeat(np.arange(range_starts.size), range_lengths)
    position_within_range = np.arange(total) - np.repeat(np.cumsum(range_lengths) - range_lengths, range_lengths)
    return source_positions, np.repeat(range_starts, range_lengths) + position_within_range


class MemoryIndex:
    """Sorted parallel arrays + binary search. Re-sorted lazily after adds."""

    def __init__(self) -> None:
        # One (hashes, audio_asset_numbers, time_offset_frames) entry per asset added since the last merge.
        self._pending: list[tuple[np.ndarray, np.ndarray, np.ndarray]] = []
        self._hashes = np.empty(0, np.int64)
        self._audio_asset_numbers = np.empty(0, np.int64)
        self._time_offset_frames = np.empty(0, np.int64)
        self._hash_counts: dict[int, int] = {}

    def add(self, audio_asset_number: int, fingerprint: Fingerprint) -> None:
        if audio_asset_number in self._hash_counts:
            raise ValueError(f"asset {audio_asset_number} already indexed")
        self._pending.append((
            fingerprint.hashes,
            np.full(len(fingerprint), audio_asset_number, np.int64),
            fingerprint.time_offset_frames.astype(np.int64),
        ))
        self._hash_counts[audio_asset_number] = len(fingerprint)

    def _merge_pending(self) -> None:
        if not self._pending:
            return
        hashes = np.concatenate([self._hashes, *(pending[0] for pending in self._pending)])
        audio_asset_numbers = np.concatenate([self._audio_asset_numbers, *(pending[1] for pending in self._pending)])
        time_offset_frames = np.concatenate([self._time_offset_frames, *(pending[2] for pending in self._pending)])
        order = np.argsort(hashes, kind="stable")
        self._hashes = hashes[order]
        self._audio_asset_numbers = audio_asset_numbers[order]
        self._time_offset_frames = time_offset_frames[order]
        self._pending.clear()

    def lookup(self, fingerprint: Fingerprint) -> Matches:
        self._merge_pending()
        if len(fingerprint) == 0 or self._hashes.size == 0:
            return Matches.empty()
        range_starts = np.searchsorted(self._hashes, fingerprint.hashes, side="left")
        range_ends = np.searchsorted(self._hashes, fingerprint.hashes, side="right")
        query_indices, reference_indices = _expand_ranges(range_starts, range_ends)
        return Matches(
            self._audio_asset_numbers[reference_indices],
            self._time_offset_frames[reference_indices],
            fingerprint.time_offset_frames[query_indices].astype(np.int64),
        )

    def hash_count(self, audio_asset_number: int) -> int:
        return self._hash_counts.get(audio_asset_number, 0)

    @property
    def total_hashes(self) -> int:
        return sum(self._hash_counts.values())


class PostgresIndex:
    """fingerprints.hashes_version_1-style table:
    (hash bigint, audio_asset_number integer, time_offset_frames integer).

    Needs the optional `postgres` extra (psycopg 3). The table name is configurable so the
    benchmark can run against a scratch table without touching real data.
    """

    def __init__(
        self,
        connection_string: str,
        table: str = "fingerprints.hashes_version_1",
        statement_timeout_milliseconds: int = 800,
    ) -> None:
        import psycopg
        from psycopg import sql

        self._psycopg = psycopg
        schema_name, _, table_name = table.rpartition(".")
        self._schema = sql.Identifier(schema_name or "public")
        self._table = sql.Identifier(schema_name or "public", table_name)
        self._table_name = table_name
        self._statement_timeout_milliseconds = int(statement_timeout_milliseconds)
        self._connection = psycopg.connect(connection_string, autocommit=False)
        self._hash_counts: dict[int, int] = {}

    def close(self) -> None:
        self._connection.close()

    def ensure_schema(self) -> None:
        from psycopg import sql

        with self._connection.transaction(), self._connection.cursor() as cursor:
            cursor.execute(sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(self._schema))
            cursor.execute(sql.SQL(
                "CREATE TABLE IF NOT EXISTS {} "
                "(hash bigint NOT NULL, audio_asset_number integer NOT NULL, time_offset_frames integer NOT NULL)"
            ).format(self._table))
            cursor.execute(sql.SQL(
                "CREATE INDEX IF NOT EXISTS {} ON {} (hash) INCLUDE (audio_asset_number, time_offset_frames)"
            ).format(sql.Identifier(f"{self._table_name}_hash_index"), self._table))
            cursor.execute(sql.SQL("CREATE INDEX IF NOT EXISTS {} ON {} (audio_asset_number)").format(
                sql.Identifier(f"{self._table_name}_audio_asset_index"), self._table))

    def truncate(self) -> None:
        from psycopg import sql

        with self._connection.transaction(), self._connection.cursor() as cursor:
            cursor.execute(sql.SQL("TRUNCATE {}").format(self._table))
        self._hash_counts.clear()

    def add(self, audio_asset_number: int, fingerprint: Fingerprint) -> None:
        """Idempotent re-ingest: replace the asset's rows in one transaction."""
        from psycopg import sql

        with self._connection.transaction(), self._connection.cursor() as cursor:
            cursor.execute(
                sql.SQL("DELETE FROM {} WHERE audio_asset_number = %s").format(self._table), (audio_asset_number,))
            copy_statement = sql.SQL(
                "COPY {} (hash, audio_asset_number, time_offset_frames) FROM STDIN").format(self._table)
            with cursor.copy(copy_statement) as copy:
                copy.set_types(["int8", "int4", "int4"])
                for hash_value, time_offset in zip(
                        fingerprint.hashes.tolist(), fingerprint.time_offset_frames.tolist()):
                    copy.write_row((hash_value, audio_asset_number, time_offset))
        self._hash_counts[audio_asset_number] = len(fingerprint)

    def lookup(self, fingerprint: Fingerprint) -> Matches:
        from psycopg import sql

        if len(fingerprint) == 0:
            return Matches.empty()
        unique_hashes = np.unique(fingerprint.hashes)
        with self._connection.transaction(), self._connection.cursor() as cursor:
            cursor.execute(sql.SQL("SET LOCAL statement_timeout = {}").format(
                sql.Literal(self._statement_timeout_milliseconds)))
            cursor.execute(
                sql.SQL(
                    "SELECT hash, audio_asset_number, time_offset_frames FROM {} WHERE hash = ANY(%s::bigint[])"
                ).format(self._table),
                (unique_hashes.tolist(),),
            )
            rows = cursor.fetchall()
        if not rows:
            return Matches.empty()
        matched_rows = np.asarray(rows, dtype=np.int64)   # columns: hash, audio_asset_number, time_offset_frames
        # Join database rows back to every query landmark carrying the same hash.
        order = np.argsort(fingerprint.hashes, kind="stable")
        sorted_query_hashes = fingerprint.hashes[order]
        sorted_query_time_offset_frames = fingerprint.time_offset_frames[order].astype(np.int64)
        range_starts = np.searchsorted(sorted_query_hashes, matched_rows[:, 0], side="left")
        range_ends = np.searchsorted(sorted_query_hashes, matched_rows[:, 0], side="right")
        row_indices, query_indices = _expand_ranges(range_starts, range_ends)
        return Matches(
            matched_rows[row_indices, 1], matched_rows[row_indices, 2], sorted_query_time_offset_frames[query_indices])

    def hash_count(self, audio_asset_number: int) -> int:
        if audio_asset_number not in self._hash_counts:
            from psycopg import sql

            with self._connection.transaction(), self._connection.cursor() as cursor:
                cursor.execute(
                    sql.SQL("SELECT count(*) FROM {} WHERE audio_asset_number = %s").format(self._table),
                    (audio_asset_number,),
                )
                self._hash_counts[audio_asset_number] = int(cursor.fetchone()[0])
        return self._hash_counts[audio_asset_number]
