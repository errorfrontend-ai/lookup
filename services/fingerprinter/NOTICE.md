# Notice

The fingerprinting in `lookup_fingerprint` follows the landmark algorithm published by
**Dejavu** (https://github.com/worldveil/dejavu, MIT License, Copyright (c) 2013 Will Drevo):
spectrogram peaks paired into (anchor frequency, target frequency, time delta) landmarks, matched by
the offset most landmarks agree on.

It is a rewrite, not a copy: no Dejavu source file is included, and Dejavu is not a dependency.
The rewrite resamples every input to one canonical rate, packs landmarks exactly into integers
instead of truncated SHA-1 hashes, looks up all of a clip's hashes in one query, sets the peak
floor relative to the clip's own level, and requires a margin over the runner-up before calling a
match. See `docs/adr/ADR-001-fingerprint-engine.md`.
