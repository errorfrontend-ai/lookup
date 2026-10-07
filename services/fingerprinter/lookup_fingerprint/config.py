"""Fingerprint and matching parameters.

The landmark algorithm follows Dejavu (worldveil/dejavu, MIT) — spectrogram peaks paired
into (anchor frequency, target frequency, time delta) landmarks — modernised for numpy 2 /
current scipy. Two deliberate departures, both found while planning (docs/adr/ADR-001-fingerprint-engine.md):

* Every input is resampled to ONE canonical rate before fingerprinting. Dejavu fingerprints
  at the file's native rate, so a 16 kHz phone clip can never match a 44.1 kHz reference.
* Landmarks are packed exactly into an integer (no truncated SHA-1), so there are no hash
  collisions and the Postgres column can be a plain BIGINT.

The defaults are the setting ADR-001 chose from the 7 Oct 2026 synthetic run at production scale (30 ads
plus 1,000 decoys): 8 kHz, up to 10 peaks per frame, each paired with the next 10. They are provisional
until real recordings are measured at the pilot (D10). Field names are also the keys of the sweep JSON
files (spike/sweeps/), so renaming a field means updating those too.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, replace

# Which fingerprints are in the hash table. Changing any FingerprintParameters default changes every
# hash, so it needs a new version (and a new hashes_version_N table, filled by re-indexing).
FINGERPRINT_VERSION = 1


@dataclass(frozen=True)
class FingerprintParameters:
    sample_rate: int = 8000                          # canonical rate in hertz for references AND queries
    window_size: int = 1024                          # FFT size in samples (128 ms at 8000 Hz)
    overlap: float = 0.5                             # hop size = window_size * (1 - overlap)
    peak_neighborhood: int = 10                      # local-maximum footprint radius (Dejavu PEAK_NEIGHBORHOOD_SIZE)
    peak_floor_above_median_decibels: float = 10.0   # peak must exceed the clip's median level by this many dB
    maximum_peaks_per_frame: int = 10                # keep only the strongest N peaks per frame (controls density)
    fan_value: int = 10                              # pair each peak with the next N peaks (Dejavu FAN_VALUE)
    minimum_time_delta_frames: int = 0               # minimum frame distance between paired peaks
    maximum_time_delta_frames: int = 200             # maximum frame distance between paired peaks (Dejavu MAX_HASH_TIME_DELTA)

    @property
    def hop_size(self) -> int:
        """Samples between the starts of consecutive spectrogram frames."""
        return max(1, int(self.window_size * (1.0 - self.overlap)))

    @property
    def frequency_bin_count(self) -> int:
        return self.window_size // 2 + 1

    def frames_to_seconds(self, frames: float) -> float:
        return frames * self.hop_size / self.sample_rate

    def with_overrides(self, **overrides: object) -> "FingerprintParameters":
        return replace(self, **overrides)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class MatchThresholds:
    minimum_aligned_landmarks: int = 26   # T: aligned landmarks needed to call a match (ADR-001)
    minimum_margin: float = 2.0           # R: top-1 aligned / top-2 aligned (guards shared jingles/beds; ADR-001)

    def to_dict(self) -> dict:
        return asdict(self)
