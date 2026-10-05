"""Corpus manifest: one CSV row per audio file (format documented in spike/README.md)."""

from __future__ import annotations

import csv
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

ROLES = frozenset({"reference", "query", "negative", "duplicate"})
REQUIRED_COLUMNS = ("role", "path", "ad_id")

# Column names used before they were spelled out in full. Corpus manifests, capture-app sessions
# (manifest.part.csv) and captures CSVs recorded with these still load: every reader goes through
# read_csv_with_current_column_names, which renames them, and append_rows writes only the new names.
LEGACY_COLUMN_NAMES = {
    "clip_s": "clip_seconds",
    "ref_variant": "reference_variant",
    "mic": "microphone_settings",
    "start_s": "start_seconds",
    "end_s": "end_seconds",
}


class ManifestError(Exception):
    pass


@dataclass(frozen=True)
class Entry:
    """One manifest row. Apart from line_number, field names are the manifest's CSV column names,
    which the capture app (spike/capture_app) also writes, so they stay identical to the file format."""

    line_number: int
    role: str
    path: Path
    ad_id: str
    device: str = ""
    scene: str = ""
    clip_seconds: float | None = None   # clip length
    codec: str = ""
    reference_variant: str = ""         # which copy of a reference this is, e.g. "master" or "offair"
    microphone_settings: str = ""       # capture-app microphone settings, e.g. "mic/ns-off/agc-off"
    notes: str = ""


# Canonical column order. Files may have fewer (only REQUIRED_COLUMNS are mandatory) or extra columns.
MANIFEST_FIELDS = ["role", "path", "ad_id", "device", "scene", "clip_seconds", "codec", "reference_variant",
                   "microphone_settings", "notes"]


def rename_legacy_columns(row: dict) -> dict:
    """`row` with every LEGACY_COLUMN_NAMES column renamed to its current name, values untouched.
    If a row somehow carries both spellings of one column, the non-empty value is kept."""
    renamed_row: dict = {}
    for column, value in row.items():
        current_column = LEGACY_COLUMN_NAMES.get(column, column)
        if not renamed_row.get(current_column):
            renamed_row[current_column] = value
    return renamed_row


def read_csv_with_current_column_names(path: Path) -> tuple[list[str], list[dict]]:
    """Read a manifest-style CSV (a leading byte-order mark is tolerated) and return its header and
    rows with legacy column names already renamed, so callers only ever see the current names."""
    with path.open(newline="", encoding="utf-8-sig") as csv_file:
        reader = csv.DictReader(csv_file)
        header = list(dict.fromkeys(LEGACY_COLUMN_NAMES.get(column, column) for column in reader.fieldnames or []))
        rows = [rename_legacy_columns(row) for row in reader]
    return header, rows


def append_rows(manifest: Path, rows: list[dict]) -> int:
    """Append rows, skipping paths already listed, and widen the header if the new rows carry
    columns the file lacks. The whole file is rewritten so every row stays aligned, which also
    brings a manifest with legacy column names up to the current names. Returns rows added."""
    existing_rows: list[dict] = []
    header: list[str] = []
    if manifest.exists():
        header, existing_rows = read_csv_with_current_column_names(manifest)
    rows = [rename_legacy_columns(row) for row in rows]
    known_paths = {row.get("path") for row in existing_rows}
    new_rows = [row for row in rows if row.get("path") not in known_paths]
    columns = [column for column in MANIFEST_FIELDS if column in header or any(column in row for row in new_rows)]
    columns += [column for column in header if column not in columns]
    columns += [column for row in new_rows for column in row if column not in columns]
    temporary_path = manifest.with_suffix(manifest.suffix + ".tmp")
    with temporary_path.open("w", newline="", encoding="utf-8") as temporary_file:
        writer = csv.DictWriter(temporary_file, fieldnames=columns, restval="")
        writer.writeheader()
        writer.writerows(existing_rows + new_rows)
    temporary_path.replace(manifest)
    return len(new_rows)


def load_manifest(path: Path, *, reference_variant: str | None = None) -> list[Entry]:
    """Parse and validate; reports every problem at once. `reference_variant` selects which
    reference copies to index (e.g. clean 'master' vs 'offair' captures of the same ad)."""
    base_directory = path.parent
    problems: list[str] = []
    entries: list[Entry] = []
    header, rows = read_csv_with_current_column_names(path)
    missing = [column for column in REQUIRED_COLUMNS if column not in header]
    if missing:
        raise ManifestError(f"{path}: missing columns {missing}")
    for line_number, row in enumerate(rows, start=2):
        role = (row.get("role") or "").strip()
        relative_path = (row.get("path") or "").strip()
        ad_id = (row.get("ad_id") or "").strip()
        clip_seconds_text = (row.get("clip_seconds") or "").strip()
        if role not in ROLES:
            problems.append(f"line {line_number}: role {role!r} not in {sorted(ROLES)}")
            continue
        if role in {"reference", "query", "duplicate"} and not ad_id:
            problems.append(f"line {line_number}: {role} needs an ad_id")
        if role == "negative" and ad_id:
            problems.append(f"line {line_number}: negative must not have an ad_id")
        file_path = (base_directory / relative_path).resolve()
        if not relative_path or not file_path.is_file():
            problems.append(f"line {line_number}: file not found: {relative_path!r}")
        try:
            clip_seconds = float(clip_seconds_text) if clip_seconds_text else None
        except ValueError:
            problems.append(f"line {line_number}: clip_seconds {clip_seconds_text!r} is not a number")
            clip_seconds = None
        entries.append(Entry(
            line_number=line_number, role=role, path=file_path, ad_id=ad_id, clip_seconds=clip_seconds,
            device=(row.get("device") or "").strip(), scene=(row.get("scene") or "").strip(),
            codec=(row.get("codec") or "").strip(),
            reference_variant=(row.get("reference_variant") or "").strip(),
            microphone_settings=(row.get("microphone_settings") or "").strip(),
            notes=(row.get("notes") or "").strip(),
        ))

    if reference_variant is not None:
        entries = [entry for entry in entries
                   if entry.role != "reference" or entry.reference_variant == reference_variant]
    references_per_ad = Counter(entry.ad_id for entry in entries if entry.role == "reference")
    for ad_id, count in references_per_ad.items():
        if count > 1:
            problems.append(f"ad_id {ad_id!r} has {count} references in the selected variant — "
                            "index one copy per ad (use --reference-variant, or role=duplicate for extra copies)")
    referenced_ad_ids = set(references_per_ad)
    for entry in entries:
        if entry.role in {"query", "duplicate"} and entry.ad_id not in referenced_ad_ids:
            problems.append(f"line {entry.line_number}: {entry.role} ad_id {entry.ad_id!r} has no reference")
    if not referenced_ad_ids:
        problems.append("no reference rows selected")
    if problems:
        raise ManifestError(f"{path}:\n  " + "\n  ".join(problems))
    return entries
