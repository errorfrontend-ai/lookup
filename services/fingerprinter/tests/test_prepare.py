from __future__ import annotations

import csv

from bench.prepare import prepare
from bench.synthetic_audio import SOURCE_SAMPLE_RATE, synthesize_ad, write_wav


def test_prepare_cuts_encodes_and_is_rerunnable(tmp_path):
    write_wav(tmp_path / "cap_ad1.wav", synthesize_ad(1, 14.0), SOURCE_SAMPLE_RATE)
    write_wav(tmp_path / "cap_talk.wav", synthesize_ad(2, 14.0), SOURCE_SAMPLE_RATE)
    (tmp_path / "captures.csv").write_text(
        "path,ad_id,device,scene,start_seconds,end_seconds\n"
        "cap_ad1.wav,ad1,itel-a70,vehicle,1,13\n"
        "cap_talk.wav,,itel-a70,market,,\n",
        encoding="utf-8",
    )
    manifest = tmp_path / "manifest.csv"

    added = prepare(tmp_path / "captures.csv", manifest, [3.0, 8.0], ["aac24", "wav"], clips_per_length=2, seed=1)
    again = prepare(tmp_path / "captures.csv", manifest, [3.0, 8.0], ["aac24", "wav"], clips_per_length=2, seed=1)

    rows = list(csv.DictReader(manifest.open(encoding="utf-8")))
    assert added == 2 * 2 * 2 * 2          # captures x lengths x clips_per_length x codecs
    assert again == 0 and len(rows) == added
    assert {row["role"] for row in rows if row["ad_id"] == "ad1"} == {"query"}
    assert {row["role"] for row in rows if not row["ad_id"]} == {"negative"}
    assert all((tmp_path / row["path"]).is_file() for row in rows)
