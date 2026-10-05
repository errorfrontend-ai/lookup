"""Phase 0 benchmark: run a corpus through the matcher and score it against the exit criteria.

Usage:
  python -m bench.run --manifest <manifest.csv> [--reference-variant master]
                      [--parameters parameters.json] [--sweep sweep.json]
                      [--minimum-aligned-landmarks T] [--minimum-margin R]
                      [--index memory|postgres] [--database-url URL] [--ship-codec aac24]
                      [--distractors 1000] [--distractor-seconds 30]
                      [--output-directory ../../spike/reports] [--require-exit-criteria]

Latency numbers are only meaningful for the exit check when run CPU-limited, e.g. inside
`docker run --cpus=1 ...` (the plan's target is 1 vCPU on Render), not on a dev laptop.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from lookup_fingerprint import (
    DecodeError, FingerprintParameters, MatchThresholds, Matcher, MemoryIndex, PostgresIndex,
    decode_audio, fingerprint,
)

from .manifest import Entry, load_manifest
from .synthetic_audio import synthesize_ad

# Synthetic "other ads" that pad the index to production size, so lookup latency and
# false-positive rates are measured against a realistic index, not a toy one.
DISTRACTOR_ASSET_NUMBER_BASE = 10_000_000
DISTRACTOR_SEED_BASE = 900_000

# Phase 0 exit criteria (plan O1) — proposals until the user signs them off.
TARGETS = {
    "accuracy_8_second_clips": 0.90,          # top-1 correct on 8 s realistic clips
    "false_positive_rate": 0.005,             # negatives that return MATCH
    "wrong_match_rate": 0.005,                # queries that return the WRONG ad (worse than no match)
    "p95_total_milliseconds": 1000.0,         # decode + fingerprint + lookup + align, 1 vCPU
    "p95_upload_bytes_8_second_clips": 32 * 1024,
}
MINIMUM_ALIGNED_LANDMARKS_GRID = list(range(3, 61))   # T values tried by calibrate()
MINIMUM_MARGIN_GRID = [1.0, 1.25, 1.5, 2.0, 3.0, 4.0, 6.0]   # R values tried by calibrate()


@dataclass
class ClipOutcome:
    entry: Entry
    status: str                       # MATCH | AMBIGUOUS | NO_MATCH | ERROR
    predicted_ad_id: str | None
    best_aligned_landmarks: int
    runner_up_aligned_landmarks: int
    timings_milliseconds: dict[str, float]
    upload_bytes: int
    error_code: str = ""


@dataclass
class RunResult:
    parameters: FingerprintParameters
    thresholds: MatchThresholds
    index_kind: str
    reference_count: int
    reference_seconds: float
    total_hashes: int
    ingest_milliseconds: list[float]
    outcomes: list[ClipOutcome]
    duplicate_checks: list[dict] = field(default_factory=list)
    reference_overlaps: list[dict] = field(default_factory=list)
    distractor_count: int = 0
    distractor_seconds: float = 0.0


def evaluate(entries: list[Entry], parameters: FingerprintParameters, thresholds: MatchThresholds,
             index, index_kind: str, reference_audio_cache: dict,
             distractor_count: int = 0, distractor_seconds: float = 30.0) -> RunResult:
    matcher = Matcher(index, parameters, thresholds)
    ad_of_asset: dict[int, str] = {}
    reference_seconds, total_hashes, ingest_milliseconds, overlaps = 0.0, 0, [], []

    references = (entry for entry in entries if entry.role == "reference")
    for audio_asset_number, entry in enumerate(references, start=1):
        started_at = time.perf_counter()
        cache_key = (entry.path, parameters.sample_rate)
        if cache_key not in reference_audio_cache:
            reference_audio_cache[cache_key] = decode_audio(entry.path, parameters.sample_rate, maximum_seconds=150.0)
        samples = reference_audio_cache[cache_key]
        reference_fingerprint = fingerprint(samples, parameters)
        if ad_of_asset:   # how close is this DISTINCT ad to what's already indexed? (false-merge risk)
            nearest = matcher.duplicate_check(reference_fingerprint)
            overlaps.append({"ad_id": entry.ad_id, "nearest_ad_id": ad_of_asset.get(nearest.audio_asset_number),
                             "coverage": nearest.coverage})
        index.add(audio_asset_number, reference_fingerprint)
        ingest_milliseconds.append((time.perf_counter() - started_at) * 1e3)
        ad_of_asset[audio_asset_number] = entry.ad_id
        reference_seconds += samples.size / parameters.sample_rate
        total_hashes += len(reference_fingerprint)
    reference_count = len(ad_of_asset)

    for distractor_number in range(distractor_count):
        audio_asset_number = DISTRACTOR_ASSET_NUMBER_BASE + distractor_number
        distractor_audio = synthesize_ad(DISTRACTOR_SEED_BASE + distractor_number, distractor_seconds,
                                         sample_rate=parameters.sample_rate)
        distractor_fingerprint = fingerprint(distractor_audio, parameters)
        index.add(audio_asset_number, distractor_fingerprint)
        ad_of_asset[audio_asset_number] = f"distractor-{distractor_number}"   # any match to one of these is a wrong answer
        total_hashes += len(distractor_fingerprint)

    duplicates = []
    for entry in (entry for entry in entries if entry.role == "duplicate"):
        duplicate_fingerprint = fingerprint(
            decode_audio(entry.path, parameters.sample_rate, maximum_seconds=150.0), parameters)
        duplicate = matcher.duplicate_check(duplicate_fingerprint)
        duplicates.append({"ad_id": entry.ad_id, "linked_ad_id": ad_of_asset.get(duplicate.audio_asset_number),
                           "coverage": duplicate.coverage, "path": entry.path.name})

    outcomes: list[ClipOutcome] = []
    for entry in (entry for entry in entries if entry.role in {"query", "negative"}):
        size_bytes = entry.path.stat().st_size
        try:
            recognition = matcher.recognize_file(entry.path)
        except DecodeError as error:
            outcomes.append(ClipOutcome(entry, "ERROR", None, 0, 0, {}, size_bytes, error.code))
            continue
        result = recognition.result
        outcomes.append(ClipOutcome(
            entry, result.status,
            ad_of_asset.get(result.best.audio_asset_number) if result.best else None,
            result.best.aligned_landmarks if result.best else 0,
            result.runner_up.aligned_landmarks if result.runner_up else 0,
            recognition.timings_milliseconds, size_bytes,
        ))
    return RunResult(parameters, thresholds, index_kind, reference_count, reference_seconds, total_hashes,
                     ingest_milliseconds, outcomes, duplicates, overlaps, distractor_count,
                     distractor_count * distractor_seconds)


# ---------------------------------------------------------------- scoring

def _is_match(outcome: ClipOutcome, minimum_aligned_landmarks: int, minimum_margin: float) -> bool:
    if outcome.status == "ERROR" or outcome.best_aligned_landmarks < minimum_aligned_landmarks:
        return False
    return (outcome.runner_up_aligned_landmarks == 0
            or outcome.best_aligned_landmarks / outcome.runner_up_aligned_landmarks >= minimum_margin)


def _calculate_rates(outcomes: list[ClipOutcome], minimum_aligned_landmarks: int, minimum_margin: float) -> dict:
    queries = [outcome for outcome in outcomes if outcome.entry.role == "query"]
    negatives = [outcome for outcome in outcomes if outcome.entry.role == "negative"]
    queries_8_seconds = [outcome for outcome in queries if outcome.entry.clip_seconds == 8.0]

    def is_match(outcome: ClipOutcome) -> bool:
        return _is_match(outcome, minimum_aligned_landmarks, minimum_margin)

    def is_correct(outcome: ClipOutcome) -> bool:
        return is_match(outcome) and outcome.predicted_ad_id == outcome.entry.ad_id

    def is_wrong(outcome: ClipOutcome) -> bool:
        return is_match(outcome) and outcome.predicted_ad_id != outcome.entry.ad_id

    return {
        "accuracy": _fraction_matching(queries, is_correct), "accuracy_8_second_clips": _fraction_matching(queries_8_seconds, is_correct),
        "wrong_match_rate": _fraction_matching(queries, is_wrong), "false_positive_rate": _fraction_matching(negatives, is_match),
    }


def _fraction_matching(items: list, predicate) -> float | None:
    return (sum(1 for item in items if predicate(item)) / len(items)) if items else None


def _percentile(values: list[float], percentile: float) -> float | None:
    return float(np.percentile(values, percentile)) if values else None


def calibrate(outcomes: list[ClipOutcome]) -> dict:
    """Best (T, R) with false positives and wrong matches within target, maximising accuracy
    (on 8 s clips if present)."""
    rows = []
    for minimum_aligned_landmarks in MINIMUM_ALIGNED_LANDMARKS_GRID:
        for minimum_margin in MINIMUM_MARGIN_GRID:
            rates = _calculate_rates(outcomes, minimum_aligned_landmarks, minimum_margin)
            rows.append({"minimum_aligned_landmarks": minimum_aligned_landmarks, "minimum_margin": minimum_margin,
                         **rates})
    feasible = [row for row in rows
                if (row["false_positive_rate"] or 0) <= TARGETS["false_positive_rate"]
                and (row["wrong_match_rate"] or 0) <= TARGETS["wrong_match_rate"]]

    def score(row: dict) -> tuple:
        accuracy = row["accuracy_8_second_clips"] if row["accuracy_8_second_clips"] is not None else row["accuracy"] or 0
        return accuracy, row["minimum_aligned_landmarks"], row["minimum_margin"]

    return {"best": max(feasible, key=score) if feasible else None, "feasible_count": len(feasible)}


def summarize(run: RunResult, ship_codec: str = "aac24") -> dict:
    """`ship_codec` is the capture format the app will actually send; other codecs (e.g. WAV
    lab controls) are reported but don't count toward the upload-size exit check."""
    minimum_aligned_landmarks = run.thresholds.minimum_aligned_landmarks
    minimum_margin = run.thresholds.minimum_margin
    queries = [outcome for outcome in run.outcomes if outcome.entry.role == "query"]
    decoded = [outcome for outcome in run.outcomes if outcome.status != "ERROR"]

    groups = {}
    for attribute in ("clip_seconds", "scene", "device", "codec", "microphone_settings"):
        values = sorted({getattr(outcome.entry, attribute) for outcome in queries},
                        key=lambda value: (value is None, str(value)))
        groups[attribute] = {}
        for value in values:
            subgroup = [outcome for outcome in queries if getattr(outcome.entry, attribute) == value]
            subgroup_rates = _calculate_rates(subgroup, minimum_aligned_landmarks, minimum_margin)
            groups[attribute][str(value)] = {"count": len(subgroup),
                                             "accuracy": subgroup_rates["accuracy"],
                                             "wrong_match_rate": subgroup_rates["wrong_match_rate"]}

    latency = {}
    for stage in ("decode", "fingerprint", "lookup", "align", "total"):
        stage_milliseconds = [outcome.timings_milliseconds[stage] for outcome in decoded
                              if stage in outcome.timings_milliseconds]
        latency[stage] = {"p50": _percentile(stage_milliseconds, 50), "p95": _percentile(stage_milliseconds, 95)}
    total_milliseconds = [outcome.timings_milliseconds["total"] for outcome in decoded
                          if "total" in outcome.timings_milliseconds]
    mean_total_milliseconds = float(np.mean(total_milliseconds)) if total_milliseconds else None
    indexed_seconds = run.reference_seconds + run.distractor_seconds
    upload_bytes_by_format = {}
    for outcome in queries:
        codec_label = outcome.entry.codec or "?"
        format_label = f"{codec_label} @ {outcome.entry.clip_seconds:g}s" if outcome.entry.clip_seconds else codec_label
        upload_bytes_by_format.setdefault(format_label, []).append(outcome.upload_bytes)
    upload = {format_label: {"count": len(sizes), "p50": _percentile(sizes, 50), "p95": _percentile(sizes, 95)}
              for format_label, sizes in sorted(upload_bytes_by_format.items())}

    duplicate_coverages = [duplicate["coverage"] for duplicate in run.duplicate_checks
                           if duplicate["linked_ad_id"] == duplicate["ad_id"]]
    wrong_links = [duplicate for duplicate in run.duplicate_checks if duplicate["linked_ad_id"] != duplicate["ad_id"]]
    maximum_overlap = max((overlap["coverage"] for overlap in run.reference_overlaps), default=0.0)
    separable = bool(duplicate_coverages) and not wrong_links and min(duplicate_coverages) > maximum_overlap
    deduplication = {
        "duplicates": run.duplicate_checks,
        "minimum_duplicate_coverage": min(duplicate_coverages) if duplicate_coverages else None,
        "maximum_distinct_overlap": maximum_overlap, "separable": separable,
        "suggested_threshold": (min(duplicate_coverages) + maximum_overlap) / 2 if separable else None,
    }

    rates = _calculate_rates(run.outcomes, minimum_aligned_landmarks, minimum_margin)
    upload_bytes_8_second_clips = [outcome.upload_bytes for outcome in queries
                                   if outcome.entry.clip_seconds == 8.0 and outcome.entry.codec == ship_codec]
    exit_checks = {
        "accuracy_8_second_clips": (rates["accuracy_8_second_clips"], TARGETS["accuracy_8_second_clips"], "min"),
        "false_positive_rate": (rates["false_positive_rate"], TARGETS["false_positive_rate"], "max"),
        "wrong_match_rate": (rates["wrong_match_rate"], TARGETS["wrong_match_rate"], "max"),
        "p95_total_milliseconds": (latency["total"]["p95"], TARGETS["p95_total_milliseconds"], "max"),
        "p95_upload_bytes_8_second_clips": (_percentile(upload_bytes_8_second_clips, 95),
                                            TARGETS["p95_upload_bytes_8_second_clips"], "max"),
        "duplicates_separable": (1.0 if separable else (0.0 if run.duplicate_checks else None), 1.0, "min"),
    }
    exit_results = {}
    for check, (value, target, target_kind) in exit_checks.items():
        if value is None:
            verdict = "N/A"
        else:
            passed = value >= target if target_kind == "min" else value <= target
            verdict = "PASS" if passed else "FAIL"
        exit_results[check] = {"value": value, "target": target, "result": verdict}

    return {
        "parameters": run.parameters.to_dict(), "thresholds": run.thresholds.to_dict(), "index": run.index_kind,
        "counts": {"references": run.reference_count, "distractors": run.distractor_count, "queries": len(queries),
                   "negatives": sum(outcome.entry.role == "negative" for outcome in run.outcomes),
                   "duplicates": len(run.duplicate_checks),
                   "errors": {outcome.entry.path.name: outcome.error_code
                              for outcome in run.outcomes if outcome.status == "ERROR"}},
        "index_statistics": {
            "reference_seconds": run.reference_seconds, "indexed_seconds": indexed_seconds,
            "hashes": run.total_hashes,
            "hashes_per_second": run.total_hashes / indexed_seconds if indexed_seconds else None,
            "ingest_milliseconds_p50": _percentile(run.ingest_milliseconds, 50),
            "ingest_milliseconds_p95": _percentile(run.ingest_milliseconds, 95),
        },
        "rates": rates, "groups": groups, "latency_milliseconds": latency, "upload_bytes": upload,
        "deduplication": deduplication,
        "throughput": {"mean_total_milliseconds": mean_total_milliseconds,
                       "recognitions_per_second_per_process":
                           1000.0 / mean_total_milliseconds if mean_total_milliseconds else None},
        "calibration": calibrate(run.outcomes), "exit_criteria": exit_results, "ship_codec": ship_codec,
    }


# ---------------------------------------------------------------- rendering

def _format(value, as_percent: bool = False) -> str:
    if value is None:
        return "—"
    if as_percent:
        return f"{value * 100:.1f}%"
    return f"{value:,.1f}" if isinstance(value, float) else str(value)


def render_markdown(summary: dict, label: str) -> str:
    thresholds = summary["thresholds"]
    lines = [f"# Phase 0 benchmark — {label}", "",
             f"Index: `{summary['index']}` · thresholds T={thresholds['minimum_aligned_landmarks']} "
             f"R={thresholds['minimum_margin']}",
             f"Parameters: `{json.dumps(summary['parameters'])}`", "",
             "## Exit criteria (plan O1)", "", "| Check | Value | Target | Result |", "|---|---|---|---|"]
    for check, outcome in summary["exit_criteria"].items():
        as_percent = check in {"accuracy_8_second_clips", "false_positive_rate", "wrong_match_rate"}
        lines.append(f"| {check} | {_format(outcome['value'], as_percent)} | {_format(outcome['target'], as_percent)} "
                     f"| **{outcome['result']}** |")
    lines += ["", "_Latency counts toward the exit check only when measured at 1 vCPU (`docker run --cpus=1`). "
              f"Upload size is checked on the shipping codec `{summary['ship_codec']}` only._", ""]

    counts = summary["counts"]
    index_statistics = summary["index_statistics"]
    distractor_text = f" + {counts['distractors']:,} synthetic distractor ads" if counts.get("distractors") else ""
    lines += ["## Corpus", "",
              f"{counts['references']} references{distractor_text} "
              f"({_format(index_statistics['indexed_seconds'])} s indexed, "
              f"{index_statistics['hashes']:,} hashes, {_format(index_statistics['hashes_per_second'])} hashes/s) · "
              f"{counts['queries']} queries · {counts['negatives']} negatives · {counts['duplicates']} duplicates · "
              f"{len(counts['errors'])} decode errors", ""]
    if counts["errors"]:
        lines += ["Decode errors: " + ", ".join(f"`{file_name}` ({error_code})"
                                                for file_name, error_code in counts["errors"].items()), ""]

    rates = summary["rates"]
    lines += ["## Accuracy at configured thresholds", "",
              f"All queries: {_format(rates['accuracy'], True)} correct · "
              f"{_format(rates['wrong_match_rate'], True)} wrong ad · "
              f"negatives matched: {_format(rates['false_positive_rate'], True)}", ""]
    for attribute, table in summary["groups"].items():
        lines += [f"| {attribute} | count | accuracy | wrong ad |", "|---|---|---|---|"]
        lines += [f"| {value} | {group['count']} | {_format(group['accuracy'], True)} "
                  f"| {_format(group['wrong_match_rate'], True)} |" for value, group in table.items()]
        lines.append("")

    calibration = summary["calibration"]["best"]
    lines += ["## Threshold calibration", ""]
    if calibration:
        lines.append(f"Best feasible (FP ≤ {TARGETS['false_positive_rate']:.1%}, "
                     f"wrong ≤ {TARGETS['wrong_match_rate']:.1%}): "
                     f"**T={calibration['minimum_aligned_landmarks']}, R={calibration['minimum_margin']}** → "
                     f"accuracy {_format(calibration['accuracy'], True)}, "
                     f"8 s {_format(calibration['accuracy_8_second_clips'], True)}, "
                     f"FP {_format(calibration['false_positive_rate'], True)}")
    else:
        lines.append("**No (T, R) meets the false-positive and wrong-match targets on this corpus.**")
    lines += ["", "## Latency (ms)", "", "| stage | p50 | p95 |", "|---|---|---|"]
    lines += [f"| {stage} | {_format(percentiles['p50'])} | {_format(percentiles['p95'])} |"
              for stage, percentiles in summary["latency_milliseconds"].items()]
    throughput = summary["throughput"]
    lines += ["", f"Mean total {_format(throughput['mean_total_milliseconds'])} ms → about "
              f"{_format(throughput['recognitions_per_second_per_process'])} recognitions per second per worker process "
              "(one process per CPU core)."]
    lines += ["", "## Upload size (bytes)", "", "| codec @ length | count | p50 | p95 |", "|---|---|---|---|"]
    lines += [f"| {format_label} | {sizes['count']} | {_format(sizes['p50'])} | {_format(sizes['p95'])} |"
              for format_label, sizes in summary["upload_bytes"].items()]

    deduplication = summary["deduplication"]
    suggested_threshold_text = (f" · suggested cut-off {deduplication['suggested_threshold']:.2f}"
                                if deduplication["suggested_threshold"] else "")
    lines += ["", "## Duplicate detection (shared assets, plan D7)", "",
              f"Min coverage of true duplicates: {_format(deduplication['minimum_duplicate_coverage'])} · "
              f"max overlap between distinct ads: {_format(deduplication['maximum_distinct_overlap'])} · "
              f"separable: **{deduplication['separable']}**" + suggested_threshold_text, ""]
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- CLI

def _make_index(kind: str, database_url: str | None):
    if kind == "memory":
        return MemoryIndex()
    if not database_url:
        raise SystemExit("--index postgres needs --database-url")
    index = PostgresIndex(database_url, table="fingerprint_benchmark.hashes")
    index.ensure_schema()
    index.truncate()
    return index


def main(command_line_arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--reference-variant", default=None)
    parser.add_argument("--parameters", type=Path, help="JSON object of FingerprintParameters overrides")
    parser.add_argument("--sweep", type=Path, help="JSON list of FingerprintParameters override objects")
    parser.add_argument("--minimum-aligned-landmarks", type=int, default=MatchThresholds.minimum_aligned_landmarks)
    parser.add_argument("--minimum-margin", type=float, default=MatchThresholds.minimum_margin)
    parser.add_argument("--index", choices=["memory", "postgres"], default="memory")
    parser.add_argument("--database-url", default=None, help="PostgreSQL connection URL for --index postgres")
    parser.add_argument("--ship-codec", default="aac24", help="codec label the app will ship (upload-size check)")
    parser.add_argument("--distractors", type=int, default=0,
                        help="pad the index with N synthetic ads to measure latency and false positives at scale")
    parser.add_argument("--distractor-seconds", type=float, default=30.0)
    parser.add_argument("--output-directory", type=Path, default=Path("spike/reports"))
    parser.add_argument("--require-exit-criteria", action="store_true",
                        help="exit 1 unless every exit criterion is PASS (N/A counts as failure)")
    arguments = parser.parse_args(command_line_arguments)

    entries = load_manifest(arguments.manifest, reference_variant=arguments.reference_variant)
    base_parameters = (FingerprintParameters().with_overrides(**json.loads(arguments.parameters.read_text()))
                       if arguments.parameters else FingerprintParameters())
    variants = json.loads(arguments.sweep.read_text()) if arguments.sweep else [{}]
    thresholds = MatchThresholds(arguments.minimum_aligned_landmarks, arguments.minimum_margin)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    reference_audio_cache: dict = {}
    all_passed = True

    print(f"{'variant':<40} {'acc@8s':>7} {'wrong':>6} {'FP':>6} {'p95 ms':>7} {'hash/s':>7}  calibrated T/R → acc@8s")
    for variant_number, overrides in enumerate(variants):
        parameters = base_parameters.with_overrides(**overrides)
        index = _make_index(arguments.index, arguments.database_url)
        try:
            run = evaluate(entries, parameters, thresholds, index, arguments.index, reference_audio_cache,
                           distractor_count=arguments.distractors, distractor_seconds=arguments.distractor_seconds)
        finally:
            if isinstance(index, PostgresIndex):
                index.close()
        summary = summarize(run, ship_codec=arguments.ship_codec)
        label = ", ".join(f"{name}={value}" for name, value in overrides.items()) or "baseline"
        output_directory = arguments.output_directory / f"{timestamp}-{variant_number:02d}"
        output_directory.mkdir(parents=True, exist_ok=True)
        (output_directory / "report.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
        (output_directory / "report.md").write_text(render_markdown(summary, label), encoding="utf-8")

        rates, calibration = summary["rates"], summary["calibration"]["best"]
        calibration_text = (f"T={calibration['minimum_aligned_landmarks']} R={calibration['minimum_margin']} → "
                            f"{_format(calibration['accuracy_8_second_clips'], True)}"
                            if calibration else "none feasible")
        print(f"{label[:40]:<40} {_format(rates['accuracy_8_second_clips'], True):>7} "
              f"{_format(rates['wrong_match_rate'], True):>6} "
              f"{_format(rates['false_positive_rate'], True):>6} "
              f"{_format(summary['latency_milliseconds']['total']['p95']):>7} "
              f"{_format(summary['index_statistics']['hashes_per_second']):>7}  {calibration_text}")
        all_passed &= all(check["result"] == "PASS" for check in summary["exit_criteria"].values())

    print(f"\nreports: {arguments.output_directory / timestamp}-*")
    return 1 if (arguments.require_exit_criteria and not all_passed) else 0


if __name__ == "__main__":
    sys.exit(main())
