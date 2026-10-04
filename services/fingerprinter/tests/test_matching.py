from __future__ import annotations

import numpy as np
import pytest

from bench.synth import PHONE_RATE, SOURCE_RATE, phone_capture, synth_ad, write_aac
from lookup_fingerprint import Candidate, Fingerprint, MatchThresholds, Matcher, MemoryIndex, decide, fingerprint

from .conftest import SYNTHETIC_THRESHOLDS, to_canonical


def test_fingerprint_is_deterministic(ads, parameters):
    samples = to_canonical(ads[1], SOURCE_RATE, parameters)
    first, second = fingerprint(samples, parameters), fingerprint(samples, parameters)
    assert len(first) > 0
    assert np.array_equal(first.hashes, second.hashes)
    assert np.array_equal(first.time_offset_frames, second.time_offset_frames)


def test_phone_clip_matches_right_ad_and_offset(matcher, ads, parameters, tmp_path):
    random_generator = np.random.default_rng(11)
    start_seconds = 6.0
    clip = phone_capture(ads[3], start_seconds, 8.0, signal_to_noise_decibels=15, random_generator=random_generator)
    path = tmp_path / "query.m4a"
    write_aac(path, clip, PHONE_RATE, 24_000)            # 16 kHz AAC, like the app will send

    recognition = matcher.recognize_file(path)

    assert recognition.result.status == "MATCH"
    assert recognition.result.best.audio_asset_number == 3
    matched_start_seconds = parameters.frames_to_seconds(recognition.result.best.offset_frames)
    assert abs(matched_start_seconds - start_seconds) <= 2 * parameters.hop_size / parameters.sample_rate
    assert set(recognition.timings_milliseconds) >= {"decode", "fingerprint", "lookup", "align", "total"}


def test_skipping_resampling_breaks_matching(matcher, ads):
    """Regression for the Dejavu flaw this rewrite fixes: fingerprinting a 16 kHz clip at its
    native rate against canonical-rate references finds nothing."""
    clip_16_kilohertz = phone_capture(ads[3], 6.0, 8.0, signal_to_noise_decibels=15,
                                      random_generator=np.random.default_rng(11))
    result = matcher.recognize_samples(clip_16_kilohertz).result          # deliberately NOT resampled
    assert result.status != "MATCH"


def test_unrelated_audio_is_rejected(matcher, parameters):
    random_generator = np.random.default_rng(5)
    for seed in range(9000, 9010):
        clip = phone_capture(synth_ad(seed, 10.0), 1.0, 8.0, signal_to_noise_decibels=15,
                             random_generator=random_generator)
        result = matcher.recognize_samples(to_canonical(clip, PHONE_RATE, parameters)).result
        assert result.status != "MATCH", f"unindexed audio seed {seed} matched asset {result.best}"


def test_shared_audio_is_ambiguous_not_a_wrong_brand(ads, parameters):
    """Two assets with the same audio must never produce a confident MATCH (plan G14)."""
    index = MemoryIndex()
    shared_fingerprint = fingerprint(to_canonical(ads[2], SOURCE_RATE, parameters), parameters)
    index.add(1, shared_fingerprint)
    index.add(2, shared_fingerprint)
    clip = phone_capture(ads[2], 4.0, 8.0, signal_to_noise_decibels=15, random_generator=np.random.default_rng(3))
    matcher = Matcher(index, parameters, SYNTHETIC_THRESHOLDS)
    result = matcher.recognize_samples(to_canonical(clip, PHONE_RATE, parameters)).result
    assert result.status == "AMBIGUOUS"


@pytest.mark.parametrize(("candidates", "expected"), [
    ([], "NO_MATCH"),
    ([Candidate(1, 6, 0)], "NO_MATCH"),                          # below T
    ([Candidate(1, 30, 0)], "MATCH"),                            # no runner-up
    ([Candidate(1, 30, 0), Candidate(2, 10, 0)], "MATCH"),       # margin 3.0
    ([Candidate(1, 30, 0), Candidate(2, 20, 0)], "AMBIGUOUS"),   # margin 1.5
])
def test_decide_threshold_and_margin(candidates, expected):
    thresholds = MatchThresholds(minimum_aligned_landmarks=7, minimum_margin=2.0)
    assert decide(candidates, thresholds).status == expected


def test_duplicate_check_links_reencoded_copy_only(matcher, ads, parameters):
    from scipy.signal import resample_poly

    copy_22_kilohertz = resample_poly(ads[4].astype(np.float64), 1, 2).astype(np.float32) * 0.7
    same = matcher.duplicate_check(
        fingerprint(to_canonical(copy_22_kilohertz, SOURCE_RATE // 2, parameters), parameters))
    other = matcher.duplicate_check(
        fingerprint(to_canonical(synth_ad(777, 20.0), SOURCE_RATE, parameters), parameters))
    assert same.audio_asset_number == 4 and same.coverage >= 0.3
    assert other.coverage < 0.1


def test_memory_index_rejects_double_add():
    index = MemoryIndex()
    two_landmarks = Fingerprint(np.array([1, 2], np.int64), np.array([0, 1], np.int32), frame_count=2)
    index.add(1, two_landmarks)
    with pytest.raises(ValueError):
        index.add(1, two_landmarks)
