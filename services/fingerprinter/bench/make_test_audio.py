"""Writes the recordings the API's end-to-end tests upload and send (apps/api/test/fingerprint-workers.test.ts):

* ad.wav          — a 30 s synthetic ad at 44.1 kHz, as a station would upload it
* clip.m4a        — 8 s of it from second 6, as a phone records it (16 kHz AAC at 24 kbit/s, noise at 15 dB)
* unrelated.m4a   — 8 s of a different synthetic ad, recorded the same way
* second-ad.wav   — a third, 12 s synthetic ad (its own recording, sharing nothing with ad.wav)
* second-clip.m4a — 8 s of second-ad.wav from second 2, recorded the same way as clip.m4a
* corrupt.wav     — a valid WAV header followed by bytes that are not audio
* expected.json   — how many hashes the engine makes for ad.wav, so the test can check what was stored

    python -m bench.make_test_audio --output-directory <folder>
"""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import numpy as np

from lookup_fingerprint import FingerprintParameters, decode_audio, fingerprint

from .synthetic_audio import PHONE_SAMPLE_RATE, SOURCE_SAMPLE_RATE, simulate_phone_capture, synthesize_ad, write_aac, write_wav


def write_test_audio(output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    random_generator = np.random.default_rng(2026)

    ad = synthesize_ad(7001, 30.0)
    write_wav(output / "ad.wav", ad, SOURCE_SAMPLE_RATE)
    write_aac(output / "clip.m4a", simulate_phone_capture(ad, 6.0, 8.0, 15, random_generator), PHONE_SAMPLE_RATE, 24_000)
    unrelated = synthesize_ad(9901, 20.0)
    write_aac(output / "unrelated.m4a", simulate_phone_capture(unrelated, 4.0, 8.0, 15, random_generator), PHONE_SAMPLE_RATE, 24_000)

    second_ad = synthesize_ad(7002, 12.0)
    write_wav(output / "second-ad.wav", second_ad, SOURCE_SAMPLE_RATE)
    # Its own random generator: drawing from the shared one would change corrupt.wav below.
    write_aac(output / "second-clip.m4a", simulate_phone_capture(second_ad, 2.0, 8.0, 15, np.random.default_rng(2027)),
              PHONE_SAMPLE_RATE, 24_000)

    # RIFF/WAVE header (so the API's first-bytes check passes) over a body that is not audio.
    garbage = bytes(random_generator.integers(0, 256, 40_000, dtype=np.uint8))
    header = b"RIFF" + struct.pack("<I", 36 + len(garbage)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 0x7777, 9, 1, 1, 1, 3)
    (output / "corrupt.wav").write_bytes(header + b"data" + struct.pack("<I", len(garbage)) + garbage)

    parameters = FingerprintParameters()
    ad_fingerprint = fingerprint(decode_audio((output / "ad.wav").read_bytes(), parameters.sample_rate), parameters)
    (output / "expected.json").write_text(json.dumps({"ad_hash_count": len(ad_fingerprint), "ad_duration_milliseconds": 30_000}), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output-directory", type=Path, required=True)
    output = parser.parse_args().output_directory
    write_test_audio(output)
    print(f"wrote test audio to {output}")


if __name__ == "__main__":
    main()
