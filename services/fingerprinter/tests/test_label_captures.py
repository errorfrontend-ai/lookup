from __future__ import annotations

import csv

import numpy as np
import pytest

from bench import label_captures
from bench.label_captures import FileMatch, decide, main
from bench.synthetic_audio import PHONE_SAMPLE_RATE, SOURCE_SAMPLE_RATE, simulate_phone_capture, synthesize_ad, write_aac, write_wav

REFERENCES = {"ad-one", "ad-two"}
NEGATIVES = {"unindexed-talk"}


def _corpus(tmp_path):
    """Two references, one unindexed recording, and four phone-like captures of known content."""
    for folder in ("references", "negatives", "captures"):
        (tmp_path / folder).mkdir()
    ad_one, ad_two, unindexed = synthesize_ad(11, 40.0), synthesize_ad(12, 40.0), synthesize_ad(13, 40.0)
    write_wav(tmp_path / "references" / "ad-one.wav", ad_one, SOURCE_SAMPLE_RATE)
    write_wav(tmp_path / "references" / "ad-two.wav", ad_two, SOURCE_SAMPLE_RATE)
    write_wav(tmp_path / "negatives" / "unindexed-talk.wav", unindexed, SOURCE_SAMPLE_RATE)
    random_generator = np.random.default_rng(5)
    write_aac(tmp_path / "captures" / "capture-01.m4a", simulate_phone_capture(ad_one, 20.0, 8.0, 15, random_generator), PHONE_SAMPLE_RATE, 24_000)
    write_aac(tmp_path / "captures" / "capture-02.m4a", simulate_phone_capture(ad_two, 5.0, 8.0, 15, random_generator), PHONE_SAMPLE_RATE, 24_000)
    write_aac(tmp_path / "captures" / "capture-03.m4a", simulate_phone_capture(unindexed, 12.0, 8.0, 15, random_generator), PHONE_SAMPLE_RATE, 24_000)
    quiet_room = (0.0005 * random_generator.standard_normal(8 * PHONE_SAMPLE_RATE)).astype(np.float32)
    write_aac(tmp_path / "captures" / "capture-04.m4a", quiet_room, PHONE_SAMPLE_RATE, 24_000)


def test_labels_each_capture_by_what_was_really_playing_and_writes_the_manifest(tmp_path):
    _corpus(tmp_path)
    assert main(["--corpus", str(tmp_path)]) == 0
    rows = {row["path"]: row for row in csv.DictReader((tmp_path / "manifest.csv").open(encoding="utf-8"))}

    assert {path for path, row in rows.items() if row["role"] == "reference"} == {"references/ad-one.wav", "references/ad-two.wav"}
    assert (rows["captures/capture-01.m4a"]["role"], rows["captures/capture-01.m4a"]["ad_id"]) == ("query", "ad-one")
    assert (rows["captures/capture-02.m4a"]["role"], rows["captures/capture-02.m4a"]["ad_id"]) == ("query", "ad-two")
    assert (rows["captures/capture-03.m4a"]["role"], rows["captures/capture-03.m4a"]["ad_id"]) == ("negative", "")
    assert (rows["captures/capture-04.m4a"]["role"], rows["captures/capture-04.m4a"]["scene"]) == ("negative", "room")
    assert rows["captures/capture-01.m4a"]["clip_seconds"] == "8.0"
    assert "capture-01.m4a" in (tmp_path / "labels.md").read_text(encoding="utf-8")


def test_the_cross_correlation_finds_the_offset_the_capture_was_cut_at(tmp_path):
    _corpus(tmp_path)
    references, labels = label_captures.label_corpus(tmp_path)
    first = next(label for label in labels if label.capture.name == "capture-01.m4a")
    offset = float(first.reason.split(" at ")[1].split(" s")[0])
    assert offset == pytest.approx(20.0, abs=0.5)


def test_a_reference_is_never_labelled_from_the_engine_alone():
    # Weak, unclear cross-correlation, but the engine is sure: a query needs independent evidence.
    matches = [FileMatch("ad-one", 6.0, 10.0), FileMatch("ad-two", 5.5, 3.0), FileMatch("unindexed-talk", 2.0, 0.0)]
    role, *_ , reason = decide(matches, REFERENCES, NEGATIVES, -30.0, [("ad-one", 300), ("ad-two", 4)])
    assert role is None and reason.startswith("dropped")


def test_an_unindexed_recording_may_be_confirmed_by_a_strong_engine_match_in_the_top_two():
    matches = [FileMatch("ad-two", 6.2, 109.9), FileMatch("unindexed-talk", 6.1, 1.0), FileMatch("ad-one", 3.0, 0.0)]
    assert decide(matches, REFERENCES, NEGATIVES, -28.0, [("unindexed-talk", 141), ("ad-two", 21)])[0] == "negative"
    # Not in the cross-correlation's top two: dropped.
    matches[1] = FileMatch("unindexed-talk", 1.0, 1.0)
    assert decide(matches, REFERENCES, NEGATIVES, -28.0, [("unindexed-talk", 141), ("ad-two", 21)])[0] is None


def test_a_close_second_file_means_unclear_even_with_a_high_peak():
    matches = [FileMatch("ad-one", 9.5, 87.0), FileMatch("ad-two", 8.7, 4.0)]
    assert decide(matches, REFERENCES, NEGATIVES, -36.0, [])[0] is None


def test_only_a_near_silent_capture_counts_as_room_noise():
    matches = [FileMatch("ad-one", 4.6, 31.6), FileMatch("ad-two", 4.6, 2.0)]
    assert decide(matches, REFERENCES, NEGATIVES, -63.0, [])[:3] == ("negative", "", "room")
    assert decide(matches, REFERENCES, NEGATIVES, -40.0, [])[0] is None
