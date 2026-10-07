# ADR-001: Fingerprint engine and its settings

- **Status:** Accepted for building; provisional until real recordings are measured at the pilot (D10)
- **Date:** 7 October 2026
- **Deciders:** the project owner (D9 engine choice, D10 build-first), with the Step 3 build

## Context

Look Up recognises a radio ad from a few seconds of audio recorded by a listener's phone. The master
plan chose (D9) an in-house rewrite of Dejavu's landmark algorithm in Python (`services/fingerprinter`,
package `lookup_fingerprint`), with SoundFingerprinting, Olaf and audfprint as benchmark baselines only.
Phase 0 was meant to measure it on 30–50 real Zambian ads recorded by low-end phones; the user decided
(D10, 4 October 2026) to build the whole system first and test with real ads at the pilot, because
stations cannot be involved before the system exists.

Step 3 connects the engine to the API, so its settings (sample rate, peak density, thresholds, hash
type) must be fixed now, from the data that exists: synthetic ads and synthetic phone captures
(`bench/synthetic_audio.py`: 44.1 kHz ads, 16 kHz phone clips with noise at 15, 5 and 0 dB
signal-to-noise, AAC at 24 kbit/s or WAV).

## The measurement (7 October 2026)

`python -m bench.run` with 30 reference ads, **1,000 synthetic decoy ads of 30 s** (production scale:
chance matches grow with the size of the index), 270 queries (3, 5 and 8 s), 60 negative clips and 3
duplicates, in-memory index, on the development machine. Four settings:

| Setting | Hashes per second of audio | 8 s accuracy | False positives | Wrong ad | p95 total | Safe thresholds found → 8 s accuracy |
|---|---|---|---|---|---|---|
| Previous defaults (11,025 Hz, 5 peaks, fan 5) | 62.9 | 80.0 % | 0.0 % | 0.0 % | 94.9 ms | T=14, R=1.5 → 81.1 % |
| 11,025 Hz, 10 peaks, fan 10 | 125.0 | 92.2 % | 0.0 % | 0.0 % | 90.5 ms | T=16, R=1.25 → 95.6 % |
| 11,025 Hz, neighbourhood 6, 8 peaks, fan 8 | 123.6 | 96.7 % | **1.7 %** | 0.0 % | 62.4 ms | T=28, R=2.0 → 87.8 % |
| **8,000 Hz, window 1,024, 10 peaks, fan 10** | 114.7 | **100.0 %** | 0.0 % | 0.0 % | 81.4 ms | **T=26, R=2.0 → 100.0 %** |

For the chosen setting: 3 s clips 88.9 %, 5 s 90.0 %, 8 s 100.0 %; at 0 dB signal-to-noise 84.4 %;
an 8 s AAC clip at 24 kbit/s is 25.7 kB (target ≤ 32 kB); duplicates were separable (smallest
coverage of a true duplicate 0.70, largest overlap between different ads 0.0). Latency by stage
(p50 / p95): decode 18 / 37 ms, fingerprint 20 / 41 ms, lookup 0.7 / 1.9 ms, align 0.8 / 2.0 ms.
The 30 September dry run found the Postgres index adds about 15–30 ms at p95 with 2–4 million rows.

## Decision

1. **Settings (fingerprint version 1):** canonical sample rate **8,000 Hz**, window 1,024 samples
   (128 ms) with half overlap, peak neighbourhood 10, peak floor 10 dB above the clip's own median,
   **up to 10 peaks per frame, each paired with the next 10**, time deltas 0–200 frames. These are the
   defaults of `FingerprintParameters`; `FINGERPRINT_VERSION = 1` names them.
2. **Thresholds:** a match needs **T = 26** aligned landmarks and a margin of **R = 2.0** over the
   runner-up (`MatchThresholds`); below T the answer is no match, below R it is ambiguous, which the
   listener sees as no match. These are the safest values the calibration found that still keep 8 s
   accuracy at 100 %.
3. **Hashes** are exact packed integers (anchor bin, target bin, time delta) in a `bigint` column
   (`fingerprints.hashes_version_1.hash`). The largest hash these settings can produce is about
   5.3 × 10^7, far below the limit, and stays below 2^39 so it packs with a 24-bit offset while repeats
   are removed (tested in `tests/test_engine_rules.py`).
4. **Index:** Postgres (`fingerprints.hashes_version_1`, one query per clip with all its hashes as one
   bound array, 800 ms statement timeout). It keeps the workers stateless and the latency budget holds.
5. **Clip:** the app records 8 s (S4); the API accepts 2–15 s and at most 256 KiB.

## Consequences

- The numbers are from synthetic audio. Real phone recordings in minibuses and markets, FM processing
  and speech-heavy ads will score lower. **At the pilot** (P8-FIELD-TEST), the benchmark runs on real
  recordings and these settings and thresholds are re-chosen; if the engine misses the targets
  (≥ 90 % top-1 on 8 s clips, ≤ 0.5 % false positives over ≥ 200 real negatives, p95 ≤ 1 s on one
  vCPU), SoundFingerprinting is evaluated next, then Olaf after an AGPL review (O1).
- Changing any parameter changes every hash: it needs a new fingerprint version, a new
  `hashes_version_N` table and re-indexing (P8), which is why the version travels with every job.
- The engine sits behind one method, `Matcher.recognize_clip(bytes)`, so another engine can be
  swapped in behind the same worker.
- Dejavu is credited in `services/fingerprinter/NOTICE.md`; no Dejavu file is copied and it is not a
  dependency.
