"""Offset alignment: a true match has many landmarks agreeing on ONE time offset.

The top-1/top-2 margin rule (plan G14) turns "two ads share a jingle or music bed" into
AMBIGUOUS instead of confidently returning the wrong brand.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

from .config import MatchThresholds
from .index import Matches

Status = Literal["MATCH", "AMBIGUOUS", "NO_MATCH"]


@dataclass(frozen=True)
class Candidate:
    audio_asset_number: int
    aligned_landmarks: int    # landmarks agreeing on the best offset
    offset_frames: int        # reference frame where the query starts


@dataclass(frozen=True)
class MatchResult:
    status: Status
    best: Candidate | None
    runner_up: Candidate | None

    @property
    def margin(self) -> float:
        if self.best is None:
            return 0.0
        if self.runner_up is None or self.runner_up.aligned_landmarks == 0:
            return float("inf")
        return self.best.aligned_landmarks / self.runner_up.aligned_landmarks


def rank_candidates(matches: Matches, limit: int = 2) -> list[Candidate]:
    """Best offset per asset, assets ordered by aligned landmark count (desc)."""
    if len(matches) == 0:
        return []
    offset_differences = matches.reference_time_offset_frames - matches.query_time_offset_frames
    smallest_difference = int(offset_differences.min())
    shifted_differences = offset_differences - smallest_difference
    difference_span = int(shifted_differences.max()) + 1
    packed_pairs, pair_counts = np.unique(
        matches.audio_asset_numbers * difference_span + shifted_differences, return_counts=True)
    asset_numbers = packed_pairs // difference_span
    offset_frames = packed_pairs % difference_span + smallest_difference
    order = np.lexsort((-pair_counts, asset_numbers))     # per asset, highest count first
    asset_numbers, offset_frames, pair_counts = asset_numbers[order], offset_frames[order], pair_counts[order]
    first_of_each_asset = np.r_[True, asset_numbers[1:] != asset_numbers[:-1]]
    asset_numbers = asset_numbers[first_of_each_asset]
    offset_frames = offset_frames[first_of_each_asset]
    pair_counts = pair_counts[first_of_each_asset]
    top_positions = np.argsort(-pair_counts, kind="stable")[:limit]
    return [
        Candidate(int(asset_numbers[position]), int(pair_counts[position]), int(offset_frames[position]))
        for position in top_positions
    ]


def decide(candidates: list[Candidate], thresholds: MatchThresholds) -> MatchResult:
    best = candidates[0] if candidates else None
    runner_up = candidates[1] if len(candidates) > 1 else None
    if best is None or best.aligned_landmarks < thresholds.minimum_aligned_landmarks:
        return MatchResult("NO_MATCH", best, runner_up)
    result = MatchResult("MATCH", best, runner_up)
    if result.margin < thresholds.minimum_margin:
        return MatchResult("AMBIGUOUS", best, runner_up)
    return result


def align(matches: Matches, thresholds: MatchThresholds) -> MatchResult:
    return decide(rank_candidates(matches), thresholds)
