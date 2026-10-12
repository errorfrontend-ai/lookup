"""Labels phone captures by what was really playing, without trusting the fingerprint engine.

Ground truth for the over-the-air benchmark (plan "CURRENT ROUND (12 Oct 2026)"): the files a
listener's phone heard are named by a band-energy cross-correlation of each capture against every
reference and negative recording. That method shares nothing with the landmarks being tuned, so
the benchmark never marks its own homework:

- a capture of a reference becomes a ``query`` only when the cross-correlation alone is clear;
- a capture of a negative recording becomes a ``negative`` when the cross-correlation is clear, or
  when the engine (every file indexed) is very sure and the cross-correlation ranks that file in
  its top two (a negative never feeds accuracy, so the engine may help here);
- a near-silent capture is room noise, a ``negative``;
- anything else is dropped and listed, never guessed.

    python -m bench.label_captures --corpus ../../spike/corpus/real-2026-10
        [--manifest <corpus>/manifest.csv] [--device "POWER 80"] [--scene laptop-speaker]

The corpus folder holds ``references/``, ``negatives/`` and ``captures/``. Reference rows are
written for every file in ``references/`` (variant ``master``); capture rows follow the decisions,
and a short ``labels.md`` beside the manifest says why each capture was kept or dropped.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.signal import fftconvolve, stft

from lookup_fingerprint import FingerprintParameters, MemoryIndex, decode_audio, fingerprint
from lookup_fingerprint.align import rank_candidates

from .manifest import append_rows

ANALYSIS_SAMPLE_RATE = 8000
ANALYSIS_HOP_SAMPLES = 256          # 32 ms at 8 kHz
BAND_EDGES_HERTZ = np.geomspace(300, 3600, 17)   # 16 bands a phone and a small speaker both carry
CLEAR_CORRELATION_Z = 8.0           # a peak this many standard deviations above all other offsets…
CLEAR_CORRELATION_GAP = 2.5         # …and this far above the next file's peak is unmistakable
ROOM_MEDIAN_LEVEL_DECIBELS = -55.0  # a capture this quiet, in its median 100 ms, heard no speaker
STRONG_ENGINE_POINTS = 60           # engine cross-check for negatives: this many aligned landmarks…
STRONG_ENGINE_FACTOR = 5.0          # …and this many times the runner-up
CAPTURE_EXTENSIONS = (".m4a", ".mp4", ".aac", ".wav", ".ogg", ".opus")
AUDIO_EXTENSIONS = (".mp3", ".wav", ".m4a", ".mp4", ".aac", ".ogg", ".opus", ".flac")


@dataclass(frozen=True)
class FileMatch:
    name: str
    z_score: float
    offset_seconds: float


@dataclass(frozen=True)
class Label:
    capture: Path
    role: str | None        # "query" | "negative" | None (dropped)
    ad_id: str
    scene: str
    reason: str


def band_onset_envelopes(samples: np.ndarray, sample_rate: int = ANALYSIS_SAMPLE_RATE) -> np.ndarray:
    """Per-band changes in log energy over time, normalised per band. Changes (onsets) survive a
    speaker's and a microphone's colouring far better than the energies themselves."""
    _, _, spectrum = stft(samples, fs=sample_rate, nperseg=2 * ANALYSIS_HOP_SAMPLES, noverlap=ANALYSIS_HOP_SAMPLES)
    power = np.abs(spectrum) ** 2
    frequencies = np.linspace(0, sample_rate / 2, power.shape[0])
    bands = np.stack([power[(frequencies >= low) & (frequencies < high)].sum(axis=0)
                      for low, high in zip(BAND_EDGES_HERTZ[:-1], BAND_EDGES_HERTZ[1:])])
    onsets = np.diff(np.log(bands + 1e-9), axis=1)
    return (onsets - onsets.mean(axis=1, keepdims=True)) / (onsets.std(axis=1, keepdims=True) + 1e-9)


def best_offset(capture_envelopes: np.ndarray, file_envelopes: np.ndarray) -> tuple[float, float]:
    """The offset where the capture fits the file best: (peak z-score over every offset, seconds)."""
    if file_envelopes.shape[1] < capture_envelopes.shape[1]:
        return 0.0, 0.0
    correlation = sum(fftconvolve(file_envelopes[band], capture_envelopes[band][::-1], mode="valid")
                      for band in range(capture_envelopes.shape[0]))
    peak = int(np.argmax(correlation))
    z_score = float((correlation[peak] - correlation.mean()) / (correlation.std() + 1e-9))
    return z_score, peak * ANALYSIS_HOP_SAMPLES / ANALYSIS_SAMPLE_RATE


def median_level_decibels(samples: np.ndarray, sample_rate: int = ANALYSIS_SAMPLE_RATE) -> float:
    frame = sample_rate // 10
    frames = samples[: len(samples) // frame * frame].reshape(-1, frame)
    if frames.size == 0:
        return -120.0
    return float(np.median(20 * np.log10(np.sqrt(np.mean(frames ** 2, axis=1)) + 1e-12)))


def decide(file_matches: list[FileMatch], reference_names: set[str], negative_names: set[str],
           median_level: float, engine_ranking: list[tuple[str, int]]) -> tuple[str | None, str, str, str]:
    """(role, ad_id, scene, reason) for one capture, by the rules in the module docstring."""
    ranked = sorted(file_matches, key=lambda match: match.z_score, reverse=True)
    best = ranked[0] if ranked else None
    runner_up_z = ranked[1].z_score if len(ranked) > 1 else 0.0
    is_clear = best is not None and best.z_score >= CLEAR_CORRELATION_Z and best.z_score - runner_up_z >= CLEAR_CORRELATION_GAP
    if is_clear and best.name in reference_names:
        return "query", best.name, "", f"cross-correlation clear: {best.name} at {best.offset_seconds:.1f} s (z {best.z_score:.1f}, next {runner_up_z:.1f})"
    if is_clear and best.name in negative_names:
        return "negative", "", "", f"cross-correlation clear: unindexed {best.name} at {best.offset_seconds:.1f} s (z {best.z_score:.1f})"
    engine_best, engine_points = engine_ranking[0] if engine_ranking else ("", 0)
    engine_runner_up = engine_ranking[1][1] if len(engine_ranking) > 1 else 0
    top_two = {match.name for match in ranked[:2]}
    if (engine_best in negative_names and engine_points >= STRONG_ENGINE_POINTS
            and engine_points >= STRONG_ENGINE_FACTOR * max(engine_runner_up, 1) and engine_best in top_two):
        return "negative", "", "", f"unindexed {engine_best}: engine {engine_points} points (next {engine_runner_up}), cross-correlation top two"
    if median_level <= ROOM_MEDIAN_LEVEL_DECIBELS:
        return "negative", "", "room", f"room noise: median level {median_level:.1f} dB"
    shown = ", ".join(f"{match.name} z {match.z_score:.1f}" for match in ranked[:2])
    return None, "", "", f"dropped: not clear ({shown}; engine {engine_best} {engine_points})"


def _audio_files(folder: Path, extensions: tuple[str, ...]) -> list[Path]:
    return sorted(path for path in folder.iterdir() if path.suffix.lower() in extensions) if folder.exists() else []


def label_corpus(corpus: Path) -> tuple[list[Path], list[Label]]:
    """Every reference file and one Label per capture in ``corpus/captures``."""
    references = _audio_files(corpus / "references", AUDIO_EXTENSIONS)
    negatives = _audio_files(corpus / "negatives", AUDIO_EXTENSIONS)
    captures = _audio_files(corpus / "captures", CAPTURE_EXTENSIONS)
    paths = {path.stem: path for path in references + negatives}
    decoded = {name: decode_audio(path.read_bytes(), sample_rate=ANALYSIS_SAMPLE_RATE, maximum_seconds=600.0)
               for name, path in paths.items()}
    envelopes = {name: band_onset_envelopes(samples) for name, samples in decoded.items()}

    # The engine cross-check: today's settings, every reference AND negative indexed.
    parameters = FingerprintParameters()
    index = MemoryIndex()
    asset_names: dict[int, str] = {}
    for number, (name, path) in enumerate(paths.items(), start=1):
        asset_names[number] = name
        samples = decoded[name] if parameters.sample_rate == ANALYSIS_SAMPLE_RATE else decode_audio(
            path.read_bytes(), sample_rate=parameters.sample_rate, maximum_seconds=600.0)
        index.add(number, fingerprint(samples, parameters))

    labels = []
    for capture in captures:
        samples = decode_audio(capture.read_bytes(), sample_rate=ANALYSIS_SAMPLE_RATE)
        capture_envelopes = band_onset_envelopes(samples)
        file_matches = [FileMatch(name, *best_offset(capture_envelopes, file_envelopes)) for name, file_envelopes in envelopes.items()]
        engine_samples = samples if parameters.sample_rate == ANALYSIS_SAMPLE_RATE else decode_audio(
            capture.read_bytes(), sample_rate=parameters.sample_rate)
        candidates = rank_candidates(index.lookup(fingerprint(engine_samples, parameters)), limit=2)
        engine_ranking = [(asset_names[candidate.audio_asset_number], candidate.aligned_landmarks) for candidate in candidates]
        role, ad_id, scene, reason = decide(file_matches, {path.stem for path in references}, {path.stem for path in negatives},
                                            median_level_decibels(samples), engine_ranking)
        labels.append(Label(capture, role, ad_id, scene, reason))
    return references, labels


def main(command_line_arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--device", default="POWER 80")
    parser.add_argument("--scene", default="laptop-speaker")
    parser.add_argument("--microphone-settings", default="mic/ns-off/agc-off")
    arguments = parser.parse_args(command_line_arguments)
    corpus = arguments.corpus.resolve()
    manifest = (arguments.manifest or corpus / "manifest.csv").resolve()

    references, labels = label_corpus(corpus)

    def relative(path: Path) -> str:
        return path.resolve().relative_to(manifest.parent).as_posix()

    rows = [{"role": "reference", "path": relative(path), "ad_id": path.stem, "reference_variant": "master"} for path in references]
    for label in labels:
        if label.role is None:
            continue
        rows.append({"role": label.role, "path": relative(label.capture), "ad_id": label.ad_id, "device": arguments.device,
                     "scene": label.scene or arguments.scene, "clip_seconds": "8.0", "codec": "aac24",
                     "microphone_settings": arguments.microphone_settings, "notes": label.reason})
    added = append_rows(manifest, rows)

    lines = ["# Capture labels", "", "| Capture | Decision | Why |", "|---|---|---|"]
    for label in labels:
        decision = f"{label.role} {label.ad_id}".strip() if label.role else "dropped"
        lines.append(f"| {label.capture.name} | {decision} | {label.reason} |")
    (manifest.parent / "labels.md").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    kept = sum(1 for label in labels if label.role)
    print(f"{len(references)} references, {kept} of {len(labels)} captures labelled, {added} rows added to {manifest}")
    for line in lines[4:]:
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
