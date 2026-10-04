from __future__ import annotations

import numpy as np
import pytest

from bench.synth import SOURCE_RATE, synth_ad
from lookup_fingerprint import FingerprintParameters, MatchThresholds, Matcher, MemoryIndex, fingerprint
from scipy.signal import resample_poly

# Thresholds calibrated by bench.run on the synthetic corpus. They keep these tests meaningful;
# production values come from the real Phase 0 corpus, not from here.
SYNTHETIC_THRESHOLDS = MatchThresholds(minimum_aligned_landmarks=7, minimum_margin=2.0)


def to_canonical(samples: np.ndarray, input_sample_rate: int, parameters: FingerprintParameters) -> np.ndarray:
    return resample_poly(samples.astype(np.float64), parameters.sample_rate, input_sample_rate).astype(np.float32)


@pytest.fixture(scope="session")
def parameters() -> FingerprintParameters:
    return FingerprintParameters()


@pytest.fixture(scope="session")
def ads() -> dict[int, np.ndarray]:
    """Five 20 s synthetic ads at 44.1 kHz keyed by audio asset number."""
    return {audio_asset_number: synth_ad(500 + audio_asset_number, seconds=20.0) for audio_asset_number in range(1, 6)}


@pytest.fixture()
def matcher(ads, parameters) -> Matcher:
    index = MemoryIndex()
    for audio_asset_number, signal in ads.items():
        index.add(audio_asset_number, fingerprint(to_canonical(signal, SOURCE_RATE, parameters), parameters))
    return Matcher(index, parameters, SYNTHETIC_THRESHOLDS)
