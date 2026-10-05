from __future__ import annotations

import json
from pathlib import Path

import pytest

from bench.manifest import ManifestError, load_manifest
from bench.run import main
from bench.synthetic_audio import generate_corpus


@pytest.fixture(scope="module")
def corpus(tmp_path_factory) -> Path:
    output_directory = tmp_path_factory.mktemp("corpus")
    return generate_corpus(output_directory, ad_count=3, ad_seconds=12.0, clip_lengths_seconds=(8,),
                           signal_to_noise_levels_decibels=(15,), negative_count=4, codecs=("aac24",),
                           duplicate_count=1, seed=77)


def _latest_report(output_directory: Path) -> dict:
    return json.loads(sorted(output_directory.glob("*/report.json"))[-1].read_text())


def test_gate_passes_on_clean_corpus(corpus, tmp_path):
    exit_code = main(["--manifest", str(corpus), "--minimum-aligned-landmarks", "7",
                      "--output-directory", str(tmp_path), "--require-exit-criteria"])
    report = _latest_report(tmp_path)
    assert exit_code == 0, report["exit_criteria"]
    assert report["rates"]["accuracy_8_second_clips"] == 1.0
    assert report["rates"]["false_positive_rate"] == 0.0
    assert report["deduplication"]["separable"] is True


def test_gate_can_fail(corpus, tmp_path):
    """A gate that cannot fail is worth nothing: impossible thresholds must exit non-zero."""
    exit_code = main(["--manifest", str(corpus), "--minimum-aligned-landmarks", "100000",
                      "--output-directory", str(tmp_path), "--require-exit-criteria"])
    assert exit_code == 1
    assert _latest_report(tmp_path)["exit_criteria"]["accuracy_8_second_clips"]["result"] == "FAIL"


def test_distractors_pad_the_index_without_breaking_matches(corpus, tmp_path):
    exit_code = main(["--manifest", str(corpus), "--minimum-aligned-landmarks", "7",
                      "--output-directory", str(tmp_path), "--distractors", "5", "--distractor-seconds", "10"])
    report = _latest_report(tmp_path)
    assert exit_code == 0
    assert report["counts"]["distractors"] == 5
    assert report["index_statistics"]["indexed_seconds"] == report["index_statistics"]["reference_seconds"] + 50
    assert report["rates"]["accuracy_8_second_clips"] == 1.0
    assert report["rates"]["wrong_match_rate"] == 0.0
    assert report["throughput"]["recognitions_per_second_per_process"] > 0


def test_manifest_reports_every_problem(tmp_path):
    (tmp_path / "a.wav").write_bytes(b"x")
    (tmp_path / "manifest.csv").write_text(
        "role,path,ad_id\n"
        "reference,a.wav,ad1\n"
        "reference,a.wav,ad1\n"          # two references for one ad
        "query,missing.wav,ad1\n"        # file not found
        "query,a.wav,ad9\n"              # no reference for ad9
        "bogus,a.wav,ad1\n",             # bad role
        encoding="utf-8",
    )
    with pytest.raises(ManifestError) as exception_information:
        load_manifest(tmp_path / "manifest.csv")
    message = str(exception_information.value)
    for fragment in ("2 references", "file not found", "'ad9' has no reference", "role 'bogus'"):
        assert fragment in message
