"""The alignment module on its own: ranking candidates by their best offset, and the decision."""

from __future__ import annotations

import json

import numpy as np
import pytest

from lookup_fingerprint import Candidate, Matches, MatchThresholds, decide, rank_candidates

THRESHOLDS = MatchThresholds(minimum_aligned_landmarks=7, minimum_margin=2.0)


def _matches(rows: list[tuple[int, int, int]]) -> Matches:
    assets, references, queries = (np.array(column, dtype=np.int64) for column in zip(*rows))
    return Matches(assets, references, queries)


def test_ranks_each_asset_by_the_landmarks_agreeing_on_its_best_offset():
    # Asset 1: four landmarks agree on offset 10, one on offset 3. Asset 2: three agree on offset 50.
    rows = [(1, 10 + query, query) for query in range(4)] + [(1, 3, 0)] + [(2, 50 + query, query) for query in range(3)]
    candidates = rank_candidates(_matches(rows))
    assert candidates == [Candidate(1, 4, 10), Candidate(2, 3, 50)]


def test_no_matches_give_no_candidates_and_no_match():
    assert rank_candidates(Matches.empty()) == []
    assert decide([], THRESHOLDS).status == "NO_MATCH"


def test_exactly_the_minimum_with_nothing_second_is_a_match():
    assert decide([Candidate(1, 7, 0)], THRESHOLDS).status == "MATCH"
    assert decide([Candidate(1, 6, 0)], THRESHOLDS).status == "NO_MATCH"


def test_exactly_the_minimum_margin_is_a_match_and_just_under_it_is_ambiguous():
    assert decide([Candidate(1, 20, 0), Candidate(2, 10, 0)], THRESHOLDS).status == "MATCH"
    assert decide([Candidate(1, 19, 0), Candidate(2, 10, 0)], THRESHOLDS).status == "AMBIGUOUS"


@pytest.mark.parametrize(
    ("candidates", "expected_margin"),
    [([Candidate(1, 30, 0)], None), ([Candidate(1, 30, 0), Candidate(2, 10, 0)], 3.0)],
)
def test_the_margin_travels_as_json(candidates, expected_margin):
    """An uncontested match has an infinite margin, which JSON cannot carry: it travels as null."""
    result = decide(candidates, THRESHOLDS)
    assert result.margin_over_runner_up == expected_margin
    json.dumps({"match_margin": result.margin_over_runner_up}, allow_nan=False)
