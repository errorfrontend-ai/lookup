"""Synthetic corpus for harness self-tests and CI smoke runs.

This proves the PIPELINE works end to end; it says nothing about real-world accuracy.
Only the real Phase 0 corpus (phone captures of real Zambian radio ads) can do that.

Usage:  python -m bench.synthetic_audio --output-directory <output folder> [--ads 10] [--negatives 20] [--seed 1234]
"""

# The module name `bench.synthetic_audio` and the names SOURCE_SAMPLE_RATE, synthesize_ad and write_wav
# are imported by spike/capture_app/tool/emulator_test.py; rename them only together with that script.

from __future__ import annotations

import argparse
import csv
from pathlib import Path

import av
import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, resample_poly, sosfilt

from .manifest import MANIFEST_FIELDS

SOURCE_SAMPLE_RATE = 44100   # hertz: station-quality reference audio
PHONE_SAMPLE_RATE = 16000    # hertz: what the Look Up app records at


def synthesize_ad(seed: int, seconds: float = 30.0, sample_rate: int = SOURCE_SAMPLE_RATE) -> np.ndarray:
    """Synthesize an ad: overlapping harmonic 'notes' with envelopes over a quiet noise bed — speech/jingle-like."""
    random_generator = np.random.default_rng(seed)
    sample_count = int(seconds * sample_rate)
    signal = np.zeros(sample_count, np.float64)
    position = 0
    while position < sample_count:
        note_length = int(random_generator.uniform(0.12, 0.45) * sample_rate)
        note_times_seconds = np.arange(note_length) / sample_rate
        fundamental_hertz = random_generator.uniform(110.0, 880.0)
        note = np.zeros(note_length)
        for harmonic in range(1, int(random_generator.integers(2, 6)) + 1):
            note += (0.6 ** harmonic) * np.sin(
                2 * np.pi * fundamental_hertz * harmonic * note_times_seconds + random_generator.uniform(0, 2 * np.pi))
        envelope = np.minimum(1.0, np.minimum(note_times_seconds / 0.02,
                                              (note_times_seconds[-1] - note_times_seconds) / 0.05 + 1e-9))
        end = min(sample_count, position + note_length)
        signal[position:end] += (note * envelope)[: end - position] * random_generator.uniform(0.4, 1.0)
        position += int(note_length * random_generator.uniform(0.6, 1.0))
    signal += 0.01 * random_generator.standard_normal(sample_count)
    return (0.8 * signal / np.max(np.abs(signal))).astype(np.float32)


def simulate_phone_capture(
    signal: np.ndarray, start_seconds: float, clip_seconds: float, signal_to_noise_decibels: float,
    random_generator: np.random.Generator,
    input_sample_rate: int = SOURCE_SAMPLE_RATE, output_sample_rate: int = PHONE_SAMPLE_RATE,
) -> np.ndarray:
    """Crude phone chain: resample to 16 kHz, 200–3800 Hz band-pass, background audio + hiss, gain."""
    start_sample, length_samples = int(start_seconds * input_sample_rate), int(clip_seconds * input_sample_rate)
    segment = signal[start_sample:start_sample + length_samples].astype(np.float64)
    segment = resample_poly(segment, PHONE_SAMPLE_RATE // 100, input_sample_rate // 100) \
        if (input_sample_rate, output_sample_rate) == (SOURCE_SAMPLE_RATE, PHONE_SAMPLE_RATE) \
        else resample_poly(segment, output_sample_rate, input_sample_rate)
    segment = sosfilt(butter(4, [200, 3800], btype="band", fs=output_sample_rate, output="sos"), segment)
    babble = synthesize_ad(int(random_generator.integers(1_000_000, 2_000_000)),
                           seconds=len(segment) / output_sample_rate + 0.1,
                           sample_rate=output_sample_rate)[: len(segment)]
    noise = babble + 0.3 * random_generator.standard_normal(len(segment)) * np.std(babble)
    signal_power, noise_power = np.mean(segment ** 2), np.mean(noise ** 2) + 1e-12
    segment = segment + noise * np.sqrt(signal_power / (noise_power * 10 ** (signal_to_noise_decibels / 10)))
    segment *= random_generator.uniform(0.3, 0.9) / (np.max(np.abs(segment)) + 1e-9)
    return np.clip(segment, -1.0, 1.0).astype(np.float32)


def write_wav(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    wavfile.write(path, sample_rate, (np.clip(samples, -1, 1) * 32767).astype(np.int16))


def write_aac(path: Path, samples: np.ndarray, sample_rate: int, bits_per_second: int) -> None:
    """AAC-LC mono in an MP4/M4A container — the same format the Flutter `record` config produces.
    `bits_per_second` is the encoder's bit rate."""
    with av.open(str(path), mode="w", format="mp4") as container:
        stream = container.add_stream("aac", rate=sample_rate, layout="mono")
        stream.bit_rate = bits_per_second
        frame_size = stream.codec_context.frame_size or 1024
        pcm_samples = np.clip(samples, -1, 1).astype(np.float32)
        pcm_samples = np.pad(pcm_samples, (0, (-len(pcm_samples)) % frame_size))
        for start_sample in range(0, len(pcm_samples), frame_size):
            frame = av.AudioFrame.from_ndarray(
                pcm_samples[start_sample:start_sample + frame_size].reshape(1, -1), format="fltp", layout="mono")
            frame.sample_rate = sample_rate
            frame.pts = start_sample
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)


def _write_clip(path_stem: Path, samples: np.ndarray, sample_rate: int, codec: str) -> Path:
    """Write `samples` as `codec` ("wav", or "aac" + kilobits per second, e.g. "aac24"); returns the file path."""
    if codec == "wav":
        path = path_stem.with_suffix(".wav")
        write_wav(path, samples, sample_rate)
    elif codec.startswith("aac"):
        path = path_stem.with_suffix(".m4a")
        write_aac(path, samples, sample_rate, int(codec[3:]) * 1000)
    else:
        raise ValueError(f"unknown codec {codec!r}")
    return path


def generate_corpus(
    output_directory: Path, *, ad_count: int = 10, ad_seconds: float = 30.0,
    clip_lengths_seconds: tuple[float, ...] = (3, 5, 8),
    signal_to_noise_levels_decibels: tuple[float, ...] = (15, 5, 0), queries_per_combination: int = 1,
    negative_count: int = 20, codecs: tuple[str, ...] = ("wav", "aac24"), duplicate_count: int = 3,
    seed: int = 1234,
) -> Path:
    output_directory.mkdir(parents=True, exist_ok=True)
    random_generator = np.random.default_rng(seed)
    rows: list[dict] = []

    def add_row(role: str, path: Path, ad_id: str = "", scene: str = "", clip_seconds: float | str = "",
                codec: str = "") -> None:
        rows.append({"role": role, "path": path.relative_to(output_directory).as_posix(), "ad_id": ad_id,
                     "device": "synthetic", "scene": scene, "clip_seconds": clip_seconds, "codec": codec,
                     "reference_variant": "master" if role == "reference" else "", "notes": ""})

    ads = {f"ad{ad_number:03d}": synthesize_ad(seed + ad_number, ad_seconds) for ad_number in range(ad_count)}
    for ad_id, signal in ads.items():
        add_row("reference", _write_clip(output_directory / f"ref_{ad_id}", signal, SOURCE_SAMPLE_RATE, "wav"),
                ad_id, codec="wav")
        for clip_seconds in clip_lengths_seconds:
            for signal_to_noise_decibels in signal_to_noise_levels_decibels:
                for query_number in range(queries_per_combination):
                    codec = codecs[int(random_generator.integers(len(codecs)))]
                    start_seconds = float(random_generator.uniform(0, ad_seconds - clip_seconds))
                    clip = simulate_phone_capture(signal, start_seconds, clip_seconds, signal_to_noise_decibels,
                                                  random_generator)
                    stem = output_directory / f"q_{ad_id}_{clip_seconds:g}s_snr{signal_to_noise_decibels:g}_{query_number}"
                    add_row("query", _write_clip(stem, clip, PHONE_SAMPLE_RATE, codec), ad_id,
                            f"snr{signal_to_noise_decibels:g}", clip_seconds, codec)

    for ad_id, signal in list(ads.items())[:duplicate_count]:
        reencoded_copy = resample_poly(signal.astype(np.float64), 1, 2).astype(np.float32) * 0.7   # 22.05 kHz, quieter
        add_row("duplicate",
                _write_clip(output_directory / f"dup_{ad_id}", reencoded_copy, SOURCE_SAMPLE_RATE // 2, "aac128"),
                ad_id, codec="aac128")

    for negative_number in range(negative_count):
        unindexed_audio = synthesize_ad(seed + 50_000 + negative_number, 12.0)
        clip_seconds = float(clip_lengths_seconds[negative_number % len(clip_lengths_seconds)])
        codec = codecs[negative_number % len(codecs)]
        clip = simulate_phone_capture(
            unindexed_audio, 1.0, clip_seconds,
            signal_to_noise_levels_decibels[negative_number % len(signal_to_noise_levels_decibels)], random_generator)
        add_row("negative",
                _write_clip(output_directory / f"neg_{negative_number:03d}", clip, PHONE_SAMPLE_RATE, codec),
                scene="unindexed", clip_seconds=clip_seconds, codec=codec)

    manifest = output_directory / "manifest.csv"
    with manifest.open("w", newline="", encoding="utf-8") as manifest_file:
        writer = csv.DictWriter(manifest_file, fieldnames=MANIFEST_FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--ads", type=int, default=10)
    parser.add_argument("--negatives", type=int, default=20)
    parser.add_argument("--seed", type=int, default=1234)
    arguments = parser.parse_args()
    manifest = generate_corpus(arguments.output_directory, ad_count=arguments.ads,
                               negative_count=arguments.negatives, seed=arguments.seed)
    print(f"wrote {manifest}")


if __name__ == "__main__":
    main()
