"""Rules about the engine as a whole: exact hashes, the clip entry point, quiet recordings, what it
may depend on, what it may write, the names it uses, and that every test of it really runs."""

from __future__ import annotations

import re
import subprocess
import sys
import tomllib
from pathlib import Path

import numpy as np
import pytest

from bench.synthetic_audio import PHONE_SAMPLE_RATE, SOURCE_SAMPLE_RATE, simulate_phone_capture, write_aac
from lookup_fingerprint import Candidate, DecodeError, FingerprintParameters, MatchThresholds, decide, fingerprint
from lookup_fingerprint.fingerprint import largest_landmark_hash, pack_landmarks, unpack_landmarks
from lookup_fingerprint.matcher import CLIP_MAXIMUM_BYTES

from .conftest import to_canonical

SERVICE_ROOT = Path(__file__).resolve().parents[1]
ENGINE_FOLDERS = ("lookup_fingerprint", "workers", "bench")


def test_landmark_hashes_unpack_to_exactly_what_was_packed(parameters):
    random_generator = np.random.default_rng(3)
    last_bin = parameters.frequency_bin_count - 1
    anchors = np.r_[0, last_bin, random_generator.integers(0, last_bin + 1, 500)]
    targets = np.r_[0, last_bin, random_generator.integers(0, last_bin + 1, 500)]
    deltas = np.r_[0, parameters.maximum_time_delta_frames,
                   random_generator.integers(0, parameters.maximum_time_delta_frames + 1, 500)]
    unpacked = unpack_landmarks(pack_landmarks(anchors, targets, deltas, parameters), parameters)
    assert all(np.array_equal(original, back) for original, back in zip((anchors, targets, deltas), unpacked))


@pytest.mark.parametrize("overrides", [{}, {"sample_rate": 16000, "window_size": 2048}, {"maximum_time_delta_frames": 400}])
def test_every_hash_fits_the_bigint_column_with_room_for_the_offset(overrides):
    parameters = FingerprintParameters().with_overrides(**overrides)
    # The fingerprint packs each hash with a 24-bit offset in one int64 while removing repeats.
    assert largest_landmark_hash(parameters) < 2 ** (63 - 24)


def test_a_clip_over_256_kilobytes_is_refused_before_it_is_decoded(matcher):
    with pytest.raises(DecodeError) as refused:
        matcher.recognize_clip(b"\0" * (CLIP_MAXIMUM_BYTES + 1))
    assert str(refused.value) == "AUDIO_TOO_LARGE"


def test_a_clip_is_matched_through_the_one_entry_point(matcher, ads, tmp_path):
    clip = simulate_phone_capture(ads[2], 4.0, 8.0, signal_to_noise_decibels=15, random_generator=np.random.default_rng(21))
    path = tmp_path / "clip.m4a"
    write_aac(path, clip, PHONE_SAMPLE_RATE, 24_000)
    recognition = matcher.recognize_clip(path.read_bytes())
    assert recognition.result.status == "MATCH"
    assert recognition.result.best.audio_asset_number == 2


def test_a_much_quieter_recording_gives_a_comparable_fingerprint_and_still_matches(matcher, ads, parameters):
    """Peaks are picked against the clip's own level, so turning the radio down does not lose them."""
    clip = simulate_phone_capture(ads[4], 5.0, 8.0, signal_to_noise_decibels=15, random_generator=np.random.default_rng(8))
    normal = to_canonical(clip, PHONE_SAMPLE_RATE, parameters)
    quiet = normal * np.float32(0.01)                 # 40 dB quieter
    assert abs(len(fingerprint(quiet, parameters)) - len(fingerprint(normal, parameters))) <= 0.1 * len(fingerprint(normal, parameters))
    result = matcher.recognize_samples(quiet).result
    assert result.status == "MATCH" and result.best.audio_asset_number == 4


def _python_files() -> list[Path]:
    return [path for folder in ENGINE_FOLDERS if (SERVICE_ROOT / folder).exists() for path in (SERVICE_ROOT / folder).rglob("*.py")]


def test_no_other_engine_is_a_dependency_or_imported():
    """Dejavu's algorithm is rewritten, not vendored; SoundFingerprinting, Olaf and audfprint are
    benchmark baselines only, never something the service runs."""
    project = tomllib.loads((SERVICE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    declared = " ".join(project["dependencies"] + [item for extra in project["optional-dependencies"].values() for item in extra]).lower()
    for engine in ("dejavu", "pydejavu", "soundfingerprinting", "olaf", "audfprint"):
        assert engine not in declared
    importing_another_engine = re.compile(r"^\s*(?:from|import)\s+(?:dejavu|olaf|audfprint|soundfingerprinting)\b", re.MULTILINE)
    assert [path.name for path in _python_files() if importing_another_engine.search(path.read_text(encoding="utf-8"))] == []


def _tracked_files() -> list[Path]:
    """Every file of the service that git tracks (or, outside a checkout, every file but the virtual environment)."""
    listed = subprocess.run(["git", "ls-files"], cwd=SERVICE_ROOT, capture_output=True, text=True, timeout=60)
    if listed.returncode == 0 and listed.stdout.strip():
        return [SERVICE_ROOT / line for line in listed.stdout.splitlines() if (SERVICE_ROOT / line).is_file()]
    return [path for path in SERVICE_ROOT.rglob("*") if path.is_file() and ".venv" not in path.parts and "__pycache__" not in path.parts]


def test_no_dejavu_source_is_copied_in():
    """No file but NOTICE.md carries Dejavu's copyright line, and none defines Dejavu's own functions or class."""
    # Dejavu's copyright holder and its own definitions, built from pieces so this file never matches itself.
    markers = re.compile("|".join([
        "Will" + " Drevo",
        r"def get_2D" + r"_peaks\(",
        r"def generate" + r"_hashes\(",
        r"def _?fingerprint" + r"_worker\(",
        r"class Deja" + r"vu\b",
    ]))
    copied = [path.relative_to(SERVICE_ROOT).as_posix() for path in _tracked_files()
              if path.name != "NOTICE.md" and path.suffix in {".py", ".txt", ".md", ".toml", ".cfg", ".sql", ""}
              and markers.search(path.read_text(encoding="utf-8", errors="replace"))]
    assert copied == []


def test_the_service_runs_no_http_server():
    """The workers take jobs from the queue only; nothing in the service listens for requests."""
    serving = re.compile(r"^\s*(?:from|import)\s+(?:http\.server|socketserver|aiohttp|fastapi|flask|starlette|uvicorn|tornado|sanic|wsgiref)\b",
                         re.MULTILINE)
    assert [path.name for path in _python_files() if serving.search(path.read_text(encoding="utf-8"))] == []


def test_the_new_dependencies_are_pinned_exactly():
    """Every dependency is an exact pin; the queue library pairs with BullMQ 6.3.11 on the Node side."""
    project = tomllib.loads((SERVICE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    every_dependency = project["dependencies"] + [item for extra in project["optional-dependencies"].values() for item in extra]
    assert [item for item in every_dependency if not re.fullmatch(r"[a-z0-9_.\-]+(?:\[[a-z0-9_,]+\])?==[0-9][0-9a-z.]*", item)] == []
    assert {"bullmq==3.3.0", "structlog==26.1.0", "psycopg[binary]==3.3.6"} <= set(project["optional-dependencies"]["worker"])


def test_the_workers_hold_no_fingerprint_maths_of_their_own():
    """The workers call the engine (lookup_fingerprint); spectrograms, peaks and alignment live only there."""
    worker_files = sorted((SERVICE_ROOT / "workers").glob("*.py"))
    maths = re.compile(r"np\.fft|numpy\.fft|scipy\.(?:signal|ndimage|fft)|maximum_filter|spectrogram|stft\(|rank_candidates|argmax")
    assert [path.name for path in worker_files if maths.search(path.read_text(encoding="utf-8"))] == []
    engine_process = (SERVICE_ROOT / "workers" / "engine_process.py").read_text(encoding="utf-8")
    assert re.search(r"^from lookup_fingerprint import .*\bMatcher\b.*\bdecode_audio\b.*\bfingerprint\b", engine_process, re.MULTILINE)


def test_the_match_thresholds_are_settings_and_decide_the_outcome():
    """T and R come from MatchThresholds (ADR-001: 26 and 2.0); the same evidence is decided by them, not by constants."""
    assert (MatchThresholds().minimum_aligned_landmarks, MatchThresholds().minimum_margin) == (26, 2.0)
    borderline = [Candidate(audio_asset_number=7, aligned_landmarks=30, offset_frames=4),
                  Candidate(audio_asset_number=9, aligned_landmarks=14, offset_frames=2)]
    assert decide(borderline, MatchThresholds()).status == "MATCH"
    assert decide(borderline, MatchThresholds(minimum_aligned_landmarks=31)).status == "NO_MATCH"
    assert decide(borderline, MatchThresholds(minimum_margin=2.5)).status == "AMBIGUOUS"


def test_the_deprecated_scipy_filters_module_is_never_used():
    assert [path.name for path in _python_files() if "ndimage.filters" in path.read_text(encoding="utf-8")] == []
    # A fresh interpreter, so the import really happens with deprecation warnings as errors.
    imported = subprocess.run(
        [sys.executable, "-W", "error::DeprecationWarning", "-c", "import lookup_fingerprint"],
        cwd=SERVICE_ROOT, capture_output=True, text=True, timeout=120)
    assert imported.returncode == 0, imported.stderr[-2000:]


def test_the_dejavu_credit_is_kept():
    notice = (SERVICE_ROOT / "NOTICE.md").read_text(encoding="utf-8")
    assert "Dejavu" in notice and "MIT" in notice


def _folder_files(*folders: str) -> list[Path]:
    return sorted(path for folder in folders for path in (SERVICE_ROOT / folder).glob("*.py"))


def test_no_test_is_skipped_or_marked_as_expected_to_fail():
    """S3-TESTS-10: every test runs and can fail. The markers are spelled in pieces, so this file does
    not match its own pattern; an empty parameter list fails collection instead of being skipped."""
    marker = r"\bmark\.(?:" + "skip|skip" + "if|x" + r"fail)\b"
    call = r"\bpytest\.(?:" + "skip|x" + "fail|importor" + r"skip)\s*\("
    unittest_style = r"\bunittest\.skip|\bskip" + r"Test\s*\("
    skipping = re.compile(f"{marker}|{call}|{unittest_style}")
    assert skipping.search("@pytest.ma" + "rk.sk" + "ipif(True, reason='')") and skipping.search("pytest.importor" + "skip('x')")
    test_files = sorted((SERVICE_ROOT / "tests").glob("*.py"))
    assert len(test_files) >= 10
    assert [path.name for path in test_files if skipping.search(path.read_text(encoding="utf-8"))] == []
    pytest_options = tomllib.loads((SERVICE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))["tool"]["pytest"]["ini_options"]
    assert pytest_options.get("empty_parameter_set_mark") == "fail_at_collect"
    assert "addopts" not in pytest_options          # nothing deselects or ignores tests behind the command line's back


def test_the_engine_writes_nothing_and_the_workers_write_only_through_worker_logging():
    """S3-LOGGING-08: switching the workers' logging on cannot make the engine start emitting audio,
    paths or parameter dumps, because the engine prints and logs nothing itself; the workers write only
    through worker_logging, where audio and download addresses are removed and long values cut short."""
    printing = re.compile(r"\bprint\s*\(|\bpprint\b|\btraceback\.print_|\bsys\.(?:stdout|stderr)\b|\bwarnings\.warn\b")
    any_logging = re.compile(r"^\s*(?:import|from)\s+(?:logging|structlog)\b|\blogging\.|\bstructlog\.", re.MULTILINE)
    own_loggers = re.compile(r"^\s*(?:import|from)\s+logging\b|\blogging\.getLogger\b|\bstructlog\.(?:get_logger|configure)\b", re.MULTILINE)
    assert printing.search("print('clip', clip)") and not printing.search("fingerprint(samples)")
    assert any_logging.search("import structlog") and own_loggers.search("log = logging.getLogger(__name__)")

    engine_files = _folder_files("lookup_fingerprint")
    assert len(engine_files) >= 5
    assert [path.name for path in engine_files
            if printing.search(path.read_text(encoding="utf-8")) or any_logging.search(path.read_text(encoding="utf-8"))] == []
    worker_files = [path for path in _folder_files("workers") if path.name != "worker_logging.py"]
    assert len(worker_files) >= 8
    assert [path.name for path in worker_files
            if printing.search(path.read_text(encoding="utf-8")) or own_loggers.search(path.read_text(encoding="utf-8"))] == []


def test_the_plans_short_names_are_not_used_in_the_engine_or_the_workers():
    """S3-STRUCTURE-01, the Python half: whole files (code, strings and comments), as whole words, so
    `recognize`, `fingerprint` or `lookup_fingerprint` do not count."""
    short_names = re.compile(
        r"\b(?:recog|fp|fp_\w+|lookup_fp|asset_key|clip_ms|offset_ms|t_off|audioB64|fpVersion|w|h)\b")
    assert short_names.search("job['fp_version']") and short_names.search("offset_ms = t_off * w")
    assert not short_names.search("recognize lookup_fingerprint fingerprint_version match_offset_milliseconds")
    found = [f"{path.parent.name}/{path.name}: {match.group()}" for path in _folder_files("workers", "lookup_fingerprint")
             for match in short_names.finditer(path.read_text(encoding="utf-8"))]
    assert found == []


def test_canonical_rate_is_the_same_for_references_and_clips(ads, parameters):
    """Both sides go through to_canonical at parameters.sample_rate before fingerprinting."""
    reference = to_canonical(ads[1], SOURCE_SAMPLE_RATE, parameters)
    assert reference.dtype == np.float32
    assert len(reference) == pytest.approx(len(ads[1]) * parameters.sample_rate / SOURCE_SAMPLE_RATE, abs=2)
