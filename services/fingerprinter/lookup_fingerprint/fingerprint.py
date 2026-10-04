"""Spectrogram -> spectral peaks -> landmark hashes (Dejavu-style, vectorised)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.ndimage import generate_binary_structure, iterate_structure, maximum_filter

from .config import FingerprintParameters

# (hash << OFFSET_BITS) | offset must fit in int64 when de-duplicating (hash, offset) pairs.
_OFFSET_BITS = 24


@dataclass(frozen=True)
class Fingerprint:
    hashes: np.ndarray               # int64 landmark keys
    time_offset_frames: np.ndarray   # int32 anchor-frame index of each landmark
    frame_count: int                 # spectrogram frames in the source audio

    def __len__(self) -> int:
        return int(self.hashes.size)


def spectrogram_decibels(samples: np.ndarray, parameters: FingerprintParameters) -> np.ndarray:
    """Log-power spectrogram in decibels, shape (frequency_bin_count, frame_count)."""
    signal = np.asarray(samples, dtype=np.float32)
    window_size, hop_size = parameters.window_size, parameters.hop_size
    if signal.size < window_size:
        return np.empty((parameters.frequency_bin_count, 0), dtype=np.float32)
    frame_count = 1 + (signal.size - window_size) // hop_size
    windowed_frames = np.lib.stride_tricks.sliding_window_view(signal, window_size)[::hop_size][:frame_count]
    spectrum = np.fft.rfft(windowed_frames * np.hanning(window_size).astype(np.float32), axis=1)
    power = spectrum.real * spectrum.real + spectrum.imag * spectrum.imag
    return (10.0 * np.log10(power + 1e-12)).T.astype(np.float32)


def find_peaks(spectrogram: np.ndarray, parameters: FingerprintParameters) -> tuple[np.ndarray, np.ndarray]:
    """Local maxima above an adaptive floor. Returns (frequency_bins, frames) sorted by (frame, frequency).

    The floor is relative to the clip's median level rather than absolute (Dejavu uses an
    absolute AMP_MIN), so a quiet phone recording with auto-gain off still yields peaks.
    """
    if spectrogram.size == 0:
        return np.empty(0, np.int32), np.empty(0, np.int32)
    footprint = iterate_structure(generate_binary_structure(2, 1), parameters.peak_neighborhood)
    is_local_maximum = maximum_filter(spectrogram, footprint=footprint, mode="constant", cval=-np.inf) == spectrogram
    level_floor = float(np.median(spectrogram)) + parameters.peak_floor_above_median_decibels
    frequency_bins, frames = np.nonzero(is_local_maximum & (spectrogram > level_floor))
    if frequency_bins.size == 0:
        return frequency_bins.astype(np.int32), frames.astype(np.int32)

    if parameters.maximum_peaks_per_frame > 0:
        magnitudes = spectrogram[frequency_bins, frames]
        order = np.lexsort((-magnitudes, frames))                # by frame, strongest first
        frequency_bins, frames = frequency_bins[order], frames[order]
        group_starts = np.r_[0, np.flatnonzero(np.diff(frames)) + 1]
        group_sizes = np.diff(np.r_[group_starts, frames.size])
        rank_within_frame = np.arange(frames.size) - np.repeat(group_starts, group_sizes)
        keep = rank_within_frame < parameters.maximum_peaks_per_frame
        frequency_bins, frames = frequency_bins[keep], frames[keep]

    order = np.lexsort((frequency_bins, frames))
    return frequency_bins[order].astype(np.int32), frames[order].astype(np.int32)


def landmarks(
    frequency_bins: np.ndarray, frames: np.ndarray, parameters: FingerprintParameters,
) -> tuple[np.ndarray, np.ndarray]:
    """Pair each peak with its next `fan_value` peaks; pack (anchor frequency, target frequency,
    time delta) exactly into an int64. Returns (hashes, time_offset_frames)."""
    hash_parts: list[np.ndarray] = []
    offset_parts: list[np.ndarray] = []
    peak_count = frames.size
    for peaks_ahead in range(1, parameters.fan_value + 1):
        if peak_count <= peaks_ahead:
            break
        anchor_frames, target_frames = frames[:-peaks_ahead], frames[peaks_ahead:]
        anchor_bins, target_bins = frequency_bins[:-peaks_ahead], frequency_bins[peaks_ahead:]
        time_deltas = target_frames - anchor_frames
        within_range = ((time_deltas >= parameters.minimum_time_delta_frames)
                        & (time_deltas <= parameters.maximum_time_delta_frames))
        hash_values = ((anchor_bins[within_range].astype(np.int64) * parameters.frequency_bin_count
                        + target_bins[within_range])
                       * (parameters.maximum_time_delta_frames + 1) + time_deltas[within_range])
        hash_parts.append(hash_values)
        offset_parts.append(anchor_frames[within_range].astype(np.int64))
    if not hash_parts:
        return np.empty(0, np.int64), np.empty(0, np.int32)

    hashes = np.concatenate(hash_parts)
    time_offset_frames = np.concatenate(offset_parts)
    # One row per distinct (hash, offset): repeated pairs would double-count in alignment.
    packed = np.unique((hashes << _OFFSET_BITS) | time_offset_frames)
    return packed >> _OFFSET_BITS, (packed & ((1 << _OFFSET_BITS) - 1)).astype(np.int32)


def fingerprint(samples: np.ndarray, parameters: FingerprintParameters) -> Fingerprint:
    """Fingerprint mono float32 samples that are ALREADY at parameters.sample_rate."""
    spectrogram = spectrogram_decibels(samples, parameters)
    frequency_bins, frames = find_peaks(spectrogram, parameters)
    hashes, time_offset_frames = landmarks(frequency_bins, frames, parameters)
    return Fingerprint(hashes=hashes, time_offset_frames=time_offset_frames, frame_count=int(spectrogram.shape[1]))
