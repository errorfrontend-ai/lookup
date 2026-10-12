"""The workers' start-up check that the database holds the current fingerprint version's store (ADR-001, fingerprint
version 2). Without it, a worker started before the migrations reports healthy and then fails every job.

The message names what is missing and how to fix it; it never repeats a setting.
"""

from __future__ import annotations

from lookup_fingerprint import FINGERPRINT_VERSION, hash_table_name

REFINGERPRINT_FUNCTION = "fingerprints.record_asset_refingerprinted(integer, smallint)"


class FingerprintStoreMissing(Exception):
    pass


def check_fingerprint_store(connection, needs_refingerprint_function: bool = False) -> None:
    """Raises FingerprintStoreMissing unless the version's hash table exists (and the re-fingerprint function, for ingest)."""
    table = hash_table_name(FINGERPRINT_VERSION)
    has_table, has_function = connection.execute(
        "SELECT to_regclass(%s) IS NOT NULL, to_regprocedure(%s) IS NOT NULL", (table, REFINGERPRINT_FUNCTION)).fetchone()
    if not has_table:
        raise FingerprintStoreMissing(
            f"the database has no hash table for fingerprint version {FINGERPRINT_VERSION} ({table}): run the migrations (npm run database:migrate)")
    if needs_refingerprint_function and not has_function:
        raise FingerprintStoreMissing(f"the database has no {REFINGERPRINT_FUNCTION}: run the migrations (npm run database:migrate)")
