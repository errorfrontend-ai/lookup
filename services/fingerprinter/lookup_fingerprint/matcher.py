"""Recognition pipeline with per-stage timings (Phase 0 measures decode / fingerprint /
lookup / align separately), plus duplicate-audio detection for shared assets (plan D7)."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .align import MatchResult, decide, rank_candidates
from .config import FingerprintParameters, MatchThresholds
from .decode import decode_audio
from .fingerprint import Fingerprint, fingerprint
from .index import LandmarkIndex


@dataclass(frozen=True)
class Recognition:
    result: MatchResult
    query_hash_count: int
    timings_milliseconds: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class DuplicateCheck:
    audio_asset_number: int | None
    coverage: float            # aligned landmarks / smaller of the two fingerprints (0..1)
    aligned_landmarks: int


class Matcher:
    def __init__(
        self,
        index: LandmarkIndex,
        parameters: FingerprintParameters | None = None,
        thresholds: MatchThresholds | None = None,
    ) -> None:
        self.index = index
        self.parameters = parameters or FingerprintParameters()
        self.thresholds = thresholds or MatchThresholds()

    def recognize_samples(
        self, samples: np.ndarray, timings_milliseconds: dict[str, float] | None = None,
    ) -> Recognition:
        timings_milliseconds = dict(timings_milliseconds or {})
        started_at = time.perf_counter()
        query_fingerprint = fingerprint(samples, self.parameters)
        fingerprinted_at = time.perf_counter()
        matches = self.index.lookup(query_fingerprint)
        looked_up_at = time.perf_counter()
        result = decide(rank_candidates(matches), self.thresholds)
        aligned_at = time.perf_counter()
        timings_milliseconds.update(
            fingerprint=(fingerprinted_at - started_at) * 1e3,
            lookup=(looked_up_at - fingerprinted_at) * 1e3,
            align=(aligned_at - looked_up_at) * 1e3,
        )
        timings_milliseconds["total"] = sum(
            milliseconds for stage, milliseconds in timings_milliseconds.items() if stage != "total")
        return Recognition(
            result=result, query_hash_count=len(query_fingerprint), timings_milliseconds=timings_milliseconds)

    def recognize_file(self, source: str | Path | bytes, *, deadline_seconds: float | None = None) -> Recognition:
        started_at = time.perf_counter()
        samples = decode_audio(
            source, self.parameters.sample_rate, maximum_seconds=20.0, deadline_seconds=deadline_seconds)
        decode_milliseconds = (time.perf_counter() - started_at) * 1e3
        return self.recognize_samples(samples, timings_milliseconds={"decode": decode_milliseconds})

    def duplicate_check(self, fingerprint_to_check: Fingerprint) -> DuplicateCheck:
        """How much of `fingerprint_to_check` is already indexed under one asset at one offset.

        Near 1.0 => same audio (link to the existing asset); mid-range => partial overlap such
        as a shared jingle or a cutdown (NEEDS_REVIEW). The cut-offs come from Phase 0 data.
        """
        candidates = rank_candidates(self.index.lookup(fingerprint_to_check), limit=1)
        if not candidates or len(fingerprint_to_check) == 0:
            return DuplicateCheck(None, 0.0, 0)
        best = candidates[0]
        smaller_fingerprint_size = min(
            len(fingerprint_to_check), max(1, self.index.hash_count(best.audio_asset_number)))
        return DuplicateCheck(
            best.audio_asset_number, best.aligned_landmarks / smaller_fingerprint_size, best.aligned_landmarks)
