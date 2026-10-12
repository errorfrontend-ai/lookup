# ADR-001: Fingerprint engine and its settings

- **Status:** Accepted for building; provisional until real recordings are measured at the pilot (D10). Fingerprint
  version 2 replaced the settings and thresholds below on 12 October 2026 ("Real captures, October 2026", at the end).
- **Date:** 7 October 2026; amended 12 October 2026
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

*Correction (12 October 2026):* the per-length figures above (3 s 88.9 %, 5 s 90.0 %, 0 dB 84.4 %) were measured at
T = 7, R = 2.0, not at the chosen T = 26. At T = 26, R = 2.0 the same corpus gives 3 s 68.9 %, 5 s 83.3 %, 8 s
100.0 %, 0 dB 71.1 %, and the smallest true-duplicate coverage is 0.66 (report
`spike/reports/synthetic-20261012T093910Z-00`).

## Decision (fingerprint version 1, replaced by version 2 on 12 October 2026)

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

## Real captures, October 2026: fingerprint version 2

### Why it was measured again

On 12 October 2026 the first walkthrough on the real stack sent the listener app's clips over the air: a phone
(POWER 80, the app's 8 s AAC at 16 kHz, noise suppression and automatic gain off) heard the laptop's speaker play a
song uploaded through the portal, and the API answered "No match" almost every time. Run in memory, the clips told
why: every clip's best candidate was the right song, but with 8 to 93 aligned landmarks, and only 3 of 7 clips reached
T = 26. Version 1 had been chosen on synthetic audio alone (D10); a phone hearing a small speaker in a room makes far
fewer of the same peaks. The user chose to fix it at once, with their own songs and talk, and to let the benchmark
pick the setting, up to about three times version 1's hashes per second.

### The corpus

`spike/corpus/real-2026-10/`. None of it is in git: `.gitignore` leaves out the whole corpus folder (the audio, the
manifest and `labels.md`) and `spike/reports/`, so the corpus and every report cited here are kept on the development
machine (to be copied to the private bucket with the rest of the Phase 0 material).

- **7 references:** 4 songs from the user's own collection, each cut to its first 120 s (the longest ad Look Up
  accepts), the user's "Music test" whole (117 s), and 2 spoken ads made with the Windows voices (made-up businesses,
  no phone numbers; marked self-made in the manifest's notes).
- **16 queries,** each an 8 s clip the app recorded through the air and the walkthrough stand-in server kept, of 4
  recordings (Music test 7, Adored 6, Dark Protector 2, the bakery ad 1). 9 were labelled by
  `bench/label_captures.py`, a band-energy cross-correlation against every recording that shares nothing with the
  engine. The other 7, the first session's clips of Music test, rest on the session record alone: only Music test
  was playing. The cross-correlation could not confirm them (on 3 its top pick was another song, on 1 a tie), so
  `labels.md` lists them as dropped while the manifest keeps them as queries.
- **202 negatives:** 2 over the air (an unindexed song and the empty room) and 200 eight-second windows, 50 from each
  of the 4 unindexed recordings (2 songs and 2 self-made spoken pieces read by the same two voices as the indexed ads),
  overlapping where a recording is short.
- **1,000 synthetic decoy ads** of 30 s in the index, as on 7 October.

### The sweep

`python -m bench.run --manifest ../../spike/corpus/real-2026-10/manifest.csv --parameters ../../spike/sweeps/version-1.json --minimum-margin 2.0 --sweep ../../spike/sweeps/real-2026-10.json --distractors 1000`,
in memory, on the development machine (reports `spike/reports/20261012T085433Z-00` to `-12`; the sweep's rows are
changes to version 1, which `version-1.json` restores now that the defaults are version 2's). Each row at version 1's
thresholds (T = 26, R = 2.0), then the thresholds the calibration found most accurate with at most 0.5 % false
positives and wrong ads, and the 8 s accuracy they give. Hashes per second are the whole index's, 98 % of it the
synthetic decoys; on the real recordings alone, version 2 makes about 3 times version 1's (decision item 1).

| Setting (changes from version 1) | Hashes per second | 8 s accuracy | False positives | Wrong ad | Calibrated thresholds → 8 s accuracy |
|---|---|---|---|---|---|
| none (version 1) | 116.5 | 75.0 % | 0.0 % | 0.0 % | T=27, R=4.0 → 75.0 % |
| 20 peaks per frame | 116.6 | 75.0 % | 1.0 % | 0.0 % | T=27, R=4.0 → 75.0 % |
| floor 7 dB | 260.1 | 68.8 % | 0.0 % | 0.0 % | T=25, R=4.0 → 81.2 % |
| floor 5 dB | 272.8 | 75.0 % | 0.0 % | 0.0 % | T=23, R=3.0 → 81.2 % |
| neighbourhood 8 | 131.6 | 75.0 % | 0.0 % | 0.0 % | T=26, R=3.0 → 75.0 % |
| neighbourhood 6 | 147.6 | 87.5 % | 0.0 % | 0.0 % | T=25, R=2.0 → 93.8 % |
| fan 15 | 173.5 | 81.2 % | 0.0 % | 0.0 % | T=23, R=3.0 → 87.5 % |
| fan 20 | 229.7 | 87.5 % | 1.0 % | 0.0 % | T=28, R=4.0 → 87.5 % |
| neighbourhood 8, floor 7 dB | 351.7 | 68.8 % | 0.0 % | 0.0 % | T=25, R=3.0 → 81.2 % |
| neighbourhood 8, fan 15 | 196.2 | 87.5 % | 1.0 % | 0.0 % | T=27, R=3.0 → 87.5 % |
| floor 5 dB, fan 15 | 408.0 | 87.5 % | 0.0 % | 0.0 % | T=28, R=2.0 → 87.5 % |
| neighbourhood 8, floor 7 dB, fan 15 | 526.3 | 87.5 % | 1.0 % | 0.0 % | T=30, R=3.0 → 87.5 % |
| neighbourhood 6, floor 5 dB, 20 peaks | 658.7 | 93.8 % | 10.9 % | 0.0 % | T=47, R=3.0 → 81.2 % |
| **neighbourhood 6, fan 15** (run on its own) | **220.2** | **100.0 %** at T=26, R=3.0 | **0.0 %** | **0.0 %** | T=26, R=3.0 → 100.0 % |

Neighbourhood 6 alone reached 15 of 16, but only with T = 25: the nearest negatives (the clinic talk against the two
spoken ads, the same synthetic voices reading phrases such as "Open Monday to Saturday") aligned 23 and 24 landmarks,
one or two below it. Adding fan 15 lifted every clip (the quietest from 18 to 26 landmarks, the next from 25 to 40)
and, with R = 3.0, separated the two groups on both measures: every query is at least 3.7 times its runner-up, and
the strongest negative that is 3 times its runner-up aligns 23 landmarks; no negative is 3.5 times its runner-up.

### Decision: fingerprint version 2

1. **Settings:** version 1's, except **peak neighbourhood 6** and **each peak paired with the next 15**: 8,000 Hz,
   window 1,024 with half overlap, floor 10 dB, up to 10 peaks per frame, time deltas 0 to 200 frames. They are the
   defaults of `FingerprintParameters`; `FINGERPRINT_VERSION = 2` names them. Fingerprints are bigger: on the 7 real
   recordings 562 hashes per second against version 1's 189, **2.97 times** (from 2.67 times for the farm-shop talk to
   3.43 times for "Music test", 22,855 to 78,330 hashes); on synthetic audio 1.85 times. That is at or just over the
   "about three times" the user allowed, so the user was asked and chose to keep version 2 (12 October 2026): about
   2.7 MB of database per minute of ads instead of 0.9 MB.
2. **Thresholds:** **T = 26**, **R = 3.0**. On the real captures: 8 s accuracy 100.0 % (16 of 16), false positives
   0.0 % (0 of 202), wrong ad 0.0 % (report `spike/reports/20261012T100017Z-00`). The higher margin is the guard
   against two recordings that share a voice or a music bed.
3. **At one vCPU** (`docker run --cpus=1 --memory=1g`, Python 3.12, 1,007 recordings in the index): p95 total
   226 ms against the 1,000 ms target (decode 144, fingerprint 38, lookup 13, align 5; mean 79 ms, about 13
   recognitions a second per core), report `spike/reports/20261012T102958Z-00`, with the in-memory index. The Postgres
   lookup is not measured at version 2: on 30 September it added 15 to 35 ms at p95 with 1.9 to 3.8 million rows of
   version 1, while version 2 puts 6.8 million rows behind the same 1,007 recordings and each clip sends more hashes.
   It is measured with the load tests (P4) and at the pilot. An 8 s upload is 28,373 bytes at p95 (target 32,768).
4. **Synthetic regression** (7 October's corpus, made again: 30 ads, 270 queries, 60 negatives, 3 duplicates, 1,000
   decoys; reports `spike/reports/synthetic-20261012T100316Z-00` and, for version 1 at its own T = 26, R = 2.0,
   `synthetic-20261012T093910Z-00`): 8 s 98.9 % (version 1: 100.0 %), 5 s 96.7 % (83.3 %), 3 s 77.8 % (68.9 %),
   0 dB 83.3 % (71.1 %); false positives and wrong ads 0.0 %; duplicates still separable (smallest true-duplicate
   coverage 0.67, largest overlap between different ads 0.0). One 8 s clip in 90 is lost; shorter and noisier clips
   gain.
5. **Storage:** `fingerprints.hashes_version_2`, the same shape, foreign key and indexes as version 1 (migration
   `1791700000000-FingerprintVersionTwo`). Each worker reads and writes only its version's table
   (`hash_table_name()`); version 1's table stays, untouched, until P8 drops it.
6. **Moving existing recordings:** `npm run fingerprints:refingerprint -w @lookup/api` queues one `refingerprint` job
   per recording still on an older version, on the ingest queue. The worker downloads one of its ads' original uploads,
   refuses anything that is not that recording byte for byte (its SHA-256), fingerprints it with the current settings
   and records the version through `fingerprints.record_asset_refingerprinted`, which counts the hashes itself and
   moves only a recording on an older version; no ad changes. An upload that is an exact copy of a recording still on
   version 1 is fingerprinted for version 2 when it is linked. Development only for now: the cut-over stops the workers
   (stop the workers, migrate, restart the API so it sends version 2 jobs, start the workers on version 2,
   re-fingerprint, identify); the workers refuse to start on a database without their version's table, and the script
   exits with 1 unless every recording got there. Switching with no gap is P8 (P8-ACOUSTIC-DUPLICATES-07).
7. **The sample ads** (`apps/api/scripts/sample-audio.ts`) are a 20 s jingle with a melody, chords and a beat instead
   of 6 s of pure notes, which gave a phone 1 or 2 landmarks through the air.

### What this does not show

- 16 queries from one phone, one laptop speaker and one room, of only 4 recordings, and the setting, T and R were
  chosen on these same 16: the 100 % is in-sample, and clustered by recording, so no confidence bound applies (taken
  as 16 independent clips it would be "above 79 %"). The weakest clip sits exactly at T = 26; at T = 28 it is 15 of 16.
- 0 false positives in 202 negatives, but 200 of them are overlapping windows of 4 recordings. Even 202 independent
  clips would only bound the false-positive rate below about 1.5 %, not the 0.5 % target.
- The first out-of-sample evidence is the over-the-air check on the real stack below; the pilot's field test
  (P8-FIELD-TEST) still decides.
- Radio is not a laptop: FM processing, minibus and market noise, and 3 m distances are untested. If the pilot misses
  the targets, the next levers are the Android `unprocessed` audio source (today `AndroidAudioSource.mic` in
  `apps/mobile/lib/features/identify/data/clip_recorder.dart`) and 10 s clips, then the engines named in O1.

### Over the air on the real stack (12 October 2026)

The phone, the tunnel, the API and the version 2 workers, after the re-fingerprinting (every recording on version 2):

- **The user's phone** (the listener app, 8 s clips, the laptop speaker): "Music test" 3 of 3 and the new sample jingle
  "Summer service offer" 3 of 3 answered with the right ad (75 to 415 aligned landmarks against T = 26); 5 songs the
  user never uploaded all answered "No match" (4 to 6 landmarks). Later the same day, 4 more identifies of the two
  matched and one unindexed "No match" (5 landmarks).
- **The 11 phone captures replayed** through the tunnel as the app sends them: all 7 clips of "Music test" (version 1:
  3 of 7) answered with it, and the 4 of audio not in Look Up (an unindexed song, the empty room, and two recordings
  that are in the benchmark but not in the development database) answered "No match".

Fewer identifies than the 10 planned, all with a wide margin; the walkthrough went on.
