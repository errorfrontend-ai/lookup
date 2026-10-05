"""Cut long field captures into benchmark clips and append them to a manifest.

Record each ad (or non-ad audio, for negatives) with ANY phone recorder app, list the files in
a captures CSV, and this tool cuts random 3/5/8/10 s windows and re-encodes them the way the
Look Up app will send them (16 kHz mono AAC-LC), plus WAV controls.

captures.csv columns:  path, ad_id (empty = negative), device, scene, start_seconds, end_seconds
  start_seconds / end_seconds (optional) bound where the ad actually plays inside the recording.
  Files written with the older names start_s / end_s still work.

Usage:
  python -m bench.prepare --captures captures.csv --manifest manifest.csv
                          [--clip-lengths-seconds 3,5,8,10] [--codecs aac24,aac32,wav]
                          [--clips-per-length 2] [--seed 1]

Limitation: a recorder app's mic processing differs from the Flutter `record` config; the
capture tool (plan Phase 0) measures noise-suppression / auto-gain on vs off separately.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from lookup_fingerprint import DecodeError, decode_audio

from .manifest import append_rows, read_csv_with_current_column_names
from .synthetic_audio import PHONE_SAMPLE_RATE, _write_clip


def prepare(captures_csv: Path, manifest: Path, clip_lengths_seconds: list[float], codecs: list[str],
            clips_per_length: int, seed: int) -> int:
    random_generator = np.random.default_rng(seed)
    clips_directory = manifest.parent / "clips"
    clips_directory.mkdir(parents=True, exist_ok=True)

    existing_paths: set[str] = set()
    if manifest.exists():
        _, existing_rows = read_csv_with_current_column_names(manifest)
        existing_paths = {row["path"] for row in existing_rows}

    new_rows: list[dict] = []
    _, capture_rows = read_csv_with_current_column_names(captures_csv)
    for line_number, row in enumerate(capture_rows, start=2):
        capture_path = (captures_csv.parent / row["path"].strip()).resolve()
        ad_id = (row.get("ad_id") or "").strip()
        try:
            audio = decode_audio(capture_path, PHONE_SAMPLE_RATE, maximum_seconds=600.0,
                                 maximum_bytes=200 * 1024 * 1024)
        except (DecodeError, FileNotFoundError) as error:
            error_code = error.code if isinstance(error, DecodeError) else "FILE_NOT_FOUND"
            raise SystemExit(f"captures line {line_number}: cannot read {row['path']!r} ({error_code})") from error
        ad_start_seconds = float(row.get("start_seconds") or 0.0)
        ad_end_seconds = float(row.get("end_seconds") or audio.size / PHONE_SAMPLE_RATE)
        for clip_seconds in clip_lengths_seconds:
            if ad_end_seconds - ad_start_seconds < clip_seconds:
                continue
            for clip_number in range(clips_per_length):
                start_seconds = float(random_generator.uniform(ad_start_seconds, ad_end_seconds - clip_seconds))
                segment = audio[int(start_seconds * PHONE_SAMPLE_RATE):
                                int((start_seconds + clip_seconds) * PHONE_SAMPLE_RATE)]
                for codec in codecs:
                    stem = clips_directory / f"{capture_path.stem}_{clip_seconds:g}s_{clip_number}_{codec}"
                    already_listed_path = None
                    for suffix in (".m4a", ".wav"):
                        candidate_path = stem.with_suffix(suffix).relative_to(manifest.parent).as_posix()
                        if candidate_path in existing_paths:
                            already_listed_path = candidate_path
                    if already_listed_path:
                        continue            # already prepared on an earlier run
                    path = _write_clip(stem, segment, PHONE_SAMPLE_RATE, codec)
                    new_rows.append({
                        "role": "query" if ad_id else "negative", "ad_id": ad_id,
                        "path": path.relative_to(manifest.parent).as_posix(),
                        "device": (row.get("device") or "").strip(), "scene": (row.get("scene") or "").strip(),
                        "clip_seconds": clip_seconds, "codec": codec, "reference_variant": "",
                        "notes": f"from {capture_path.name} @ {start_seconds:.2f}s",
                    })

    return append_rows(manifest, new_rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--captures", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--clip-lengths-seconds", default="3,5,8,10")
    parser.add_argument("--codecs", default="aac24,aac32,wav")
    parser.add_argument("--clips-per-length", type=int, default=2)
    parser.add_argument("--seed", type=int, default=1)
    arguments = parser.parse_args()
    added = prepare(arguments.captures, arguments.manifest,
                    [float(length) for length in arguments.clip_lengths_seconds.split(",")],
                    [codec.strip() for codec in arguments.codecs.split(",")], arguments.clips_per_length,
                    arguments.seed)
    print(f"appended {added} clips to {arguments.manifest}")


if __name__ == "__main__":
    main()
