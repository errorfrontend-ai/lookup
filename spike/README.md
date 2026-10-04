# Phase 0 — Fingerprint accuracy spike

**Question to answer:** can the Look Up engine (our rewrite of Dejavu's landmark algorithm)
reliably recognise real Zambian radio ads, captured by low-end phone mics in real listening
conditions, fast enough? Nothing past Phase 0 is built until this passes.

## Exit criteria (proposed — sign off before the final run)

| Check | Target |
|---|---|
| Top-1 accuracy, 8 s realistic clips | ≥ 90 % |
| Unrelated audio returning a match (false positive) | ≤ 0.5 % |
| Queries returning the **wrong** ad | ≤ 0.5 % |
| p95 decode + fingerprint + lookup + align, at 1 vCPU | ≤ 1.0 s |
| p95 upload size, 8 s clip in the shipping codec | ≤ 32 KB |
| Same audio from two stations detected as one asset, no false merges | yes |

## 1. Collect the corpus

Audio never goes into git. Keep it in `spike/corpus/` locally (git-ignored) and back it up to the
private R2 bucket.

**Reference ads** (`role=reference`), 30–50 ads, with each station's written permission:
- For every ad, the **clean master** from the station's playout system (`ref_variant=master`), and
  if possible an **off-air** recording from a radio's line-out (`ref_variant=offair`).
- Deliberately include the hard cases: several ads from the same brand, 30 s and 15 s cut-downs
  of the same ad, ads sharing a jingle or music bed, and speech-heavy ads.
- The **same ad supplied by two stations**: index one copy as the reference and list the other
  as `role=duplicate` with the same `ad_id`.

**Negatives** (`role=negative`, no `ad_id`), 200+ clips: music, talk, news, station jingles and
sweepers, and ads that are *not* in the index.

**Phone captures** (become `role=query` via `bench.prepare`):
- Devices: 3–5 low-end Androids people actually carry (Tecno, Itel, Infinix, Samsung A0x).
  Put model and Android version in `device`, e.g. `itel-a70-a13`.
- Scenes (`scene`): `quiet` (radio 1 m), `far-low` (radio 3 m, low volume), `vehicle` (minibus/car),
  `market` (street/market noise), `weak-fm` (hissy reception).
- Record each ad while it plays, with any recorder app. Note in `start_s` / `end_s` where the ad
  plays inside the recording if you started early or stopped late.

### Using the capture app (recommended for phone captures)

`spike/capture_app` is a small Android app that records exactly like the Look Up app will:
AAC-LC, 16 kHz, mono, 24 or 32 kbps. It also labels every clip for the benchmark.

1. **Build and install** (or ask Claude to): `cd spike/capture_app; flutter build apk --release --split-per-abi`.
   Install `build/app/outputs/flutter-apk/app-armeabi-v7a-release.apk` on older/32-bit phones and
   `app-arm64-v8a-release.apk` on newer ones. Sideloading needs "Install unknown apps" allowed.
2. **Per recording:**
   - Set the ad id (or "Not an ad" for negatives), phone model, scene and clip length.
   - Set the takes: 2–3 back-to-back clips fit inside one 30 s ad.
   - Set the **mic settings** to compare: Android source `mic` / `voiceRecognition` / `unprocessed`, and noise suppression and auto-gain on or off.
3. **Tap Record while the ad plays.**
   - The level bar shows the mic is hearing the radio.
   - Cancel deletes a half clip.
   - After each take it warns if the audio was very loud (possible distortion) or very quiet (mic covered?).
4. **Listen back** in the **Recordings** tab (bottom bar): every clip has Play and Delete.
   A "Listen to it" button also appears right after each recording.
5. **Get the clips off the phone:** in Recordings, tap **Send to computer**. It shares the session's
   clips and `manifest.part.csv` over WhatsApp, Drive or email.
   - **Start new session** (same tab) begins a fresh batch, e.g. for a new place or day. Older
     sessions stay listed under "Earlier sessions", each with its own Send button.
   - Over USB, the files are in `Android/data/zm.lookup.lookup_capture/files/sessions/`. Newer
     Android hides this folder from file managers, so Send is the reliable way.
6. **Import:** copy the session folder into `spike/corpus/captures/`, then
   `python -m bench.import_captures --session spike/corpus/captures/<session> --manifest spike/corpus/manifest.csv`.

   The import cuts any clip that ran long back to its labelled length (the recorder can overrun
   the app's timer by up to a second on a slow phone), so a "3 s" clip is never scored as 4 s.

**Tested without a phone (1 Oct 2026):** `tool/emulator_test.py` installs the release APK on an
emulator and drives it like a person would: moving between the Record and Recordings tabs, the
form checks, the microphone prompt, recording, playback, cancel, takes in a row, mic settings,
negatives, delete, send, new session, reopening the app, and import. All 63 checks pass on the
light `lookup_test` emulator (Android 13). It cannot judge how a real phone's microphone sounds.

```powershell
emulator -avd lookup_test -no-snapshot -no-window -allow-host-audio -memory 1536   # in one terminal
cd spike/capture_app
..\..\services\fingerprinter\.venv\Scripts\python.exe tool\emulator_test.py `
  --apk build\app\outputs\flutter-apk\app-x86_64-release.apk --out <folder for screenshots>
```
(Close Docker Desktop first on an 8 GB PC. The Android 16 Play Store emulator is too heavy here.)

The report then breaks accuracy down **by mic setting**. That tells us which Android audio
source, and whether noise suppression or auto-gain, the listener app should use.

## 2. Build the manifest

`spike/corpus/manifest.csv` — one row per file, paths relative to the manifest:

```csv
role,path,ad_id,device,scene,clip_s,codec,ref_variant,notes
reference,refs/driveon_summer.wav,driveon-summer,,,,wav,master,from playout
reference,refs/driveon_summer_offair.wav,driveon-summer,,,,wav,offair,line-out capture
duplicate,refs/driveon_summer_stationB.mp3,driveon-summer,,,,mp3,,same ad from station B
negative,negatives/news_0930.m4a,,,,8,aac24,,
```

Then cut the phone captures into clips (3/5/8/10 s, AAC 24/32 kbps + WAV controls):

```csv
# spike/corpus/captures.csv
path,ad_id,device,scene,start_s,end_s
captures/itel_driveon_minibus.m4a,driveon-summer,itel-a70-a13,vehicle,2.5,31
captures/itel_market_noise.m4a,,itel-a70-a13,market,,
```

```powershell
cd services/fingerprinter
.\.venv\Scripts\python.exe -m bench.prepare --captures ..\..\spike\corpus\captures.csv --manifest ..\..\spike\corpus\manifest.csv
```

## 3. Run the benchmark

```powershell
cd services/fingerprinter
python -m venv .venv; .\.venv\Scripts\python.exe -m pip install -e ".[postgres,dev]"   # first time only

# baseline + threshold calibration (report lands in spike/reports/<timestamp>-00/report.md)
.\.venv\Scripts\python.exe -m bench.run --manifest ..\..\spike\corpus\manifest.csv --reference-variant master --output-directory ..\..\spike\reports

# parameter sweep (sample rate, window, peak density, fan-out …)
.\.venv\Scripts\python.exe -m bench.run --manifest ..\..\spike\corpus\manifest.csv --reference-variant master --sweep ..\..\spike\sweeps\starter.json --output-directory ..\..\spike\reports

# Postgres index instead of in-memory (start it with: docker compose -f infra/docker-compose.yml up -d postgres)
.\.venv\Scripts\python.exe -m bench.run --manifest ..\..\spike\corpus\manifest.csv --index postgres --database-url postgresql://lookup:lookup_development_only@127.0.0.1:55432/lookup --output-directory ..\..\spike\reports
```

Each report shows the exit-criteria table, accuracy by clip length / scene / device / codec,
the best thresholds (T = aligned landmarks, R = top-1/top-2 margin) that keep false positives
and wrong-ad matches under target, per-stage latency, upload sizes, and duplicate detection.

**Test at production size.** A 30-ad index flatters the engine: chance matches grow with index
size. Add `--distractors 1000` (1,000 synthetic 30 s ads) to every run you base a decision on,
and include `spike/sweeps/scale.json` — denser fingerprints held up far better at scale on
synthetic audio (see the 30 Sep note below).

**Latency only counts at 1 vCPU.** Laptop numbers are optimistic; run the final check in a
CPU-limited container on Python 3.12, the version the server will run:

```powershell
docker build -t lookup-fingerprint:phase0 services/fingerprinter
docker run --rm --cpus=1 --memory=1g -v "${PWD}\spike\corpus:/data" lookup-fingerprint:phase0 `
  bench.run --manifest /data/manifest.csv --reference-variant master --distractors 1000 `
  --sweep /data/scale.json --output-directory /data/reports
```
(copy `spike/sweeps/scale.json` into `spike/corpus/` first, or mount the sweeps folder too)

**30 Sep 2026 — synthetic dry run (tooling check, not a verdict):**
- At 1 vCPU with a 1,010-ad index, speed is not the risk: p95 end to end is 33–126 ms against a 1,000 ms target, about 16 recognitions a second per core, and lookup takes under 1 ms.
- The default density (~63 landmarks per second) had to trade accuracy for safety at scale: 86.7% at 8 s once false matches were held under 0.5%.
- Settings with ~115–125 landmarks per second reached 96.7–100%.
- Postgres index: the lookup step took p95 17 ms (1.9 M rows) to 34 ms (3.8 M rows), against under 2 ms in memory. End to end it stayed at p95 80–99 ms, so both index types fit the budget.
- Half a vCPU (Render Starter): p95 112–116 ms, about 14 recognitions a second.
- Real recordings decide the final settings.

## 4. Decide

Record the outcome in `docs/adr/ADR-001-fingerprint-engine.md`: the parameters, T/R, canonical
sample rate, clip length, index type (Postgres vs in-memory), duplicate cut-off, and whether the
engine passed. A fixed subset of the corpus then becomes the blocking CI accuracy gate
(`--require-exit-criteria` exits non-zero on any FAIL).

If it fails: benchmark SoundFingerprinting (MIT) next; Olaf only after an AGPL legal review.
