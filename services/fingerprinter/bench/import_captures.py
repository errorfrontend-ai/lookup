"""Merge a capture-app session (clips + manifest.part.csv) into the corpus manifest.

Copy the session folder off the phone into the corpus folder first (anywhere under the
manifest's directory, e.g. spike/corpus/captures/session_20260930T070509), then:

  python -m bench.import_captures --session <session folder> --manifest <corpus manifest.csv>

Re-running is safe: clips already listed are skipped. Sessions recorded by older builds of the
app (columns clip_s, ref_variant, mic) import too; their columns get the current names.

Clips that ran longer than their labelled length are cut to it (the recorder starts a little
before, and stops a little after, the app's timer — up to a second on a slow phone). Without
this, a "3 s" clip that is really 4 s would make that phone or mic setting look better than it is.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import av

from .manifest import append_rows, read_csv_with_current_column_names


def trim_to_length(path: Path, seconds: float, tolerance_seconds: float = 0.1) -> bool:
    """Cut a clip to `seconds` by copying its packets (no re-encode). True if it was cut."""
    temporary_path = path.with_suffix(".trim.m4a")
    with av.open(str(path)) as source:
        input_stream = source.streams.audio[0]
        if float(source.duration or 0) / av.time_base <= seconds + tolerance_seconds:
            return False
        with av.open(str(temporary_path), mode="w", format="mp4") as destination:
            output_stream = destination.add_stream_from_template(input_stream)
            for packet in source.demux(input_stream):
                if packet.dts is None:
                    continue
                if float(packet.pts * input_stream.time_base) >= seconds:
                    break
                packet.stream = output_stream
                destination.mux(packet)
    temporary_path.replace(path)
    return True


def import_session(session: Path, manifest: Path) -> int:
    part_manifest = session / "manifest.part.csv"
    if not part_manifest.is_file():
        raise SystemExit(f"{part_manifest} not found — is this a Look Up Capture session folder?")
    corpus_directory = manifest.resolve().parent
    try:
        session_prefix = session.resolve().relative_to(corpus_directory)
    except ValueError:
        raise SystemExit(
            f"Copy the session folder somewhere inside {corpus_directory} first, so clip paths stay relative."
        ) from None

    rows: list[dict] = []
    _, part_manifest_rows = read_csv_with_current_column_names(part_manifest)
    for line_number, row in enumerate(part_manifest_rows, start=2):
        row = {column: (value or "").strip() for column, value in row.items()}
        row["path"] = (session_prefix / row["path"]).as_posix()
        clip_path = corpus_directory / row["path"]
        if not clip_path.is_file():
            raise SystemExit(f"{part_manifest.name} line {line_number}: clip not found: {row['path']}")
        if row.get("clip_seconds"):
            try:
                trimmed = trim_to_length(clip_path, float(row["clip_seconds"]))
            except (av.error.FFmpegError, ValueError, IndexError) as error:
                raise SystemExit(
                    f"{part_manifest.name} line {line_number}: cannot read {row['path']} ({type(error).__name__})"
                ) from error
            if trimmed:
                row["notes"] = "; ".join(
                    note for note in (row.get("notes", ""), f"trimmed to {row['clip_seconds']} s") if note)
        rows.append(row)
    return append_rows(manifest, rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--session", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    arguments = parser.parse_args()
    added = import_session(arguments.session, arguments.manifest)
    print(f"added {added} clips to {arguments.manifest}")


if __name__ == "__main__":
    main()
