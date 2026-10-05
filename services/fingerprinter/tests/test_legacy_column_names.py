"""Files recorded before the columns were spelled out in full (clip_s, ref_variant, mic, start_s,
end_s) are already on phones and in the corpus. They must keep loading with every value intact, and
any manifest the benchmark rewrites must come out in the current names only."""

from __future__ import annotations

import csv

import pytest

from bench.import_captures import import_session
from bench.manifest import LEGACY_COLUMN_NAMES, MANIFEST_FIELDS, append_rows, load_manifest
from bench.prepare import prepare
from bench.synthetic_audio import PHONE_SAMPLE_RATE, SOURCE_SAMPLE_RATE, synthesize_ad, write_aac, write_wav

OLD_HEADER = "role,path,ad_id,device,scene,clip_s,codec,ref_variant,mic,notes\n"
CURRENT_HEADER = ",".join(MANIFEST_FIELDS) + "\n"


def _read_header_and_rows(path) -> tuple[list[str], list[dict]]:
    with path.open(newline="", encoding="utf-8") as csv_file:
        reader = csv.DictReader(csv_file)
        return list(reader.fieldnames or []), list(reader)


def test_current_header_is_the_old_header_with_full_names():
    """Same columns in the same order; only the three short names changed."""
    old_columns = OLD_HEADER.strip().split(",")
    assert [LEGACY_COLUMN_NAMES.get(column, column) for column in old_columns] == MANIFEST_FIELDS


def test_load_manifest_reads_old_column_names(tmp_path):
    for file_name in ("ref_master.wav", "ref_offair.wav", "query.m4a"):
        (tmp_path / file_name).write_bytes(b"x")            # load_manifest checks files exist, it does not decode
    manifest = tmp_path / "manifest.csv"
    manifest.write_text(
        OLD_HEADER +
        "reference,ref_master.wav,brand-a,,,,wav,master,,from playout\n"
        "reference,ref_offair.wav,brand-a,,,,wav,offair,,line-out capture\n"
        "query,query.m4a,brand-a,itel-a70-a13,vehicle,8,aac24,,mic/ns-off/agc-off,captured\n",
        encoding="utf-8",
    )

    # Selecting by variant only works if the old ref_variant values were read.
    reference, query = load_manifest(manifest, reference_variant="master")

    assert reference.path.name == "ref_master.wav"
    assert reference.reference_variant == "master" and reference.notes == "from playout"
    assert query.clip_seconds == 8.0
    assert query.microphone_settings == "mic/ns-off/agc-off"
    assert (query.device, query.scene, query.codec, query.notes) == ("itel-a70-a13", "vehicle", "aac24", "captured")
    assert load_manifest(manifest, reference_variant="offair")[0].path.name == "ref_offair.wav"


def test_append_rows_rewrites_an_old_corpus_manifest_in_current_names(tmp_path):
    manifest = tmp_path / "manifest.csv"
    manifest.write_text(
        OLD_HEADER +
        "reference,refs/ad1.wav,ad1,,,,wav,master,,from playout\n"
        "query,clips/ad1_8s.m4a,ad1,itel-a70-a13,vehicle,8,aac24,,mic/ns-on/agc-off,captured\n",
        encoding="utf-8",
    )
    new_row = {"role": "negative", "path": "clips/talk_3s.m4a", "ad_id": "", "device": "tecno-spark-10",
               "scene": "market", "clip_seconds": 3, "codec": "aac24", "reference_variant": "",
               "microphone_settings": "unprocessed/ns-off/agc-on", "notes": ""}

    assert append_rows(manifest, [new_row]) == 1

    header, rows = _read_header_and_rows(manifest)
    assert header == MANIFEST_FIELDS
    assert rows == [
        {"role": "reference", "path": "refs/ad1.wav", "ad_id": "ad1", "device": "", "scene": "",
         "clip_seconds": "", "codec": "wav", "reference_variant": "master", "microphone_settings": "",
         "notes": "from playout"},
        {"role": "query", "path": "clips/ad1_8s.m4a", "ad_id": "ad1", "device": "itel-a70-a13", "scene": "vehicle",
         "clip_seconds": "8", "codec": "aac24", "reference_variant": "", "microphone_settings": "mic/ns-on/agc-off",
         "notes": "captured"},
        {**new_row, "clip_seconds": "3"},
    ]


def test_append_rows_accepts_rows_with_old_column_names(tmp_path):
    manifest = tmp_path / "manifest.csv"
    manifest.write_text(CURRENT_HEADER + "reference,refs/ad1.wav,ad1,,,,wav,master,,\n", encoding="utf-8")

    append_rows(manifest, [{"role": "query", "path": "clips/ad1_3s.m4a", "ad_id": "ad1", "clip_s": "3",
                            "ref_variant": "", "mic": "voiceRecognition/ns-on/agc-off"}])

    header, rows = _read_header_and_rows(manifest)
    assert header == MANIFEST_FIELDS
    assert rows[1]["clip_seconds"] == "3" and rows[1]["microphone_settings"] == "voiceRecognition/ns-on/agc-off"


@pytest.mark.parametrize("corpus_header", [OLD_HEADER, CURRENT_HEADER], ids=["old corpus", "current corpus"])
def test_import_session_reads_an_old_session(tmp_path, corpus_header):
    """A session recorded by an older build of the capture app, merged into either kind of corpus."""
    write_wav(tmp_path / "ref.wav", synthesize_ad(1, 6.0), SOURCE_SAMPLE_RATE)
    manifest = tmp_path / "manifest.csv"
    manifest.write_text(corpus_header + "reference,ref.wav,brand-a,,,,wav,master,,from playout\n", encoding="utf-8")
    session = tmp_path / "captures" / "session_20260930T070509"
    session.mkdir(parents=True)
    write_aac(session / "long.m4a", synthesize_ad(1, 4.0, sample_rate=PHONE_SAMPLE_RATE), PHONE_SAMPLE_RATE,
              24_000)
    (session / "manifest.part.csv").write_text(
        OLD_HEADER + "query,long.m4a,brand-a,itel-a70-a13,vehicle,3,aac24,,mic/ns-off/agc-off,captured\n",
        encoding="utf-8",
    )

    assert import_session(session, manifest) == 1
    assert import_session(session, manifest) == 0                   # re-running is still safe

    header, rows = _read_header_and_rows(manifest)
    assert header == MANIFEST_FIELDS
    assert rows[0]["reference_variant"] == "master" and rows[0]["notes"] == "from playout"
    assert rows[1]["clip_seconds"] == "3" and rows[1]["microphone_settings"] == "mic/ns-off/agc-off"
    assert "trimmed to 3 s" in rows[1]["notes"]                      # the old clip_s still drives the trim
    query = load_manifest(manifest, reference_variant="master")[1]
    assert query.clip_seconds == 3.0 and query.microphone_settings == "mic/ns-off/agc-off"
    assert query.device == "itel-a70-a13" and query.scene == "vehicle"


def test_prepare_honours_old_start_and_end_columns(tmp_path):
    """start_s / end_s bound the ad inside the recording: a 4 s window has no room for an 8 s clip."""
    write_wav(tmp_path / "capture_ad1.wav", synthesize_ad(1, 14.0), SOURCE_SAMPLE_RATE)
    (tmp_path / "captures.csv").write_text(
        "path,ad_id,device,scene,start_s,end_s\n"
        "capture_ad1.wav,ad1,itel-a70,vehicle,1,5\n",
        encoding="utf-8",
    )
    manifest = tmp_path / "manifest.csv"

    added = prepare(tmp_path / "captures.csv", manifest, [3.0, 8.0], ["wav"], clips_per_length=2, seed=1)

    _, rows = _read_header_and_rows(manifest)
    assert added == 2 and {row["clip_seconds"] for row in rows} == {"3.0"}
    clip_start_seconds = [float(row["notes"].rsplit("@ ", 1)[1].rstrip("s")) for row in rows]
    assert all(1.0 <= start_seconds <= 2.0 for start_seconds in clip_start_seconds)
