"""What runs inside the pool's processes (see engine_pool.py). Plain functions, so they can be sent to
another process; each returns a small dict of plain values and never raises for bad audio.

Audio stays in memory throughout: PyAV decodes from the bytes, so no clip or upload is ever written
to disk.
"""

from __future__ import annotations

from typing import Any

from lookup_fingerprint import DecodeError, FingerprintParameters, Matcher, PostgresIndex, decode_audio, fingerprint

# ---- recognize ---------------------------------------------------------------------------------------

_matcher: Matcher | None = None
_database_url: str | None = None


def start_recognize_process(database_url: str) -> None:
    """Opens the process's connection when the pool starts, so no clip waits for it."""
    global _database_url
    _database_url = database_url
    _matcher_for_this_process()


def _matcher_for_this_process() -> Matcher:
    global _matcher
    if _matcher is None:
        _matcher = Matcher(PostgresIndex(_database_url))
    return _matcher


def recognize_clip_in_process(clip: bytes, decode_seconds: float) -> dict[str, Any]:
    """Decode (capped), fingerprint, look up (800 ms) and decide. Returns {"result": …} or {"failure": code}."""
    import psycopg

    global _matcher
    matcher = _matcher_for_this_process()
    try:
        recognition = matcher.recognize_clip(clip, deadline_seconds=decode_seconds)
    except DecodeError as refused:
        return {"failure": "DECODE_TIMEOUT" if refused.code == "DECODE_TIMEOUT" else "INVALID_AUDIO"}
    except psycopg.errors.QueryCanceled:
        return {"failure": "LOOKUP_TIMEOUT"}
    except psycopg.OperationalError:
        # The connection is gone; the next job opens a new one.
        _matcher = None
        raise
    result = recognition.result
    best = result.best
    is_matched_recording = best is not None and result.status in ("MATCH", "AMBIGUOUS")
    return {
        "result": {
            "status": result.status,
            "audio_asset_number": best.audio_asset_number if is_matched_recording else None,
            "aligned_hash_count": best.aligned_landmarks if best else 0,
            "match_margin": result.margin_over_runner_up if best else None,
            "match_offset_milliseconds": (
                round(matcher.parameters.frames_to_seconds(best.offset_frames) * 1000) if is_matched_recording else None),
        },
        "timings_milliseconds": {stage: round(value, 1) for stage, value in recognition.timings_milliseconds.items()},
    }


# ---- ingest ------------------------------------------------------------------------------------------

MINIMUM_AD_SECONDS = 5.0
MAXIMUM_AD_SECONDS = 120.0
# Decoding stops a little past the longest ad, so "too long" is still measured exactly.
DECODE_LIMIT_SECONDS = 121.0
MAXIMUM_UPLOAD_BYTES = 20 * 1024 * 1024
AD_DECODE_SECONDS = 30.0

_DECODE_REFUSALS = {
    "NO_AUDIO_STREAM": "no_audio_in_file",
    "AUDIO_TOO_LONG": "audio_too_long",
    "DECODE_TIMEOUT": "audio_took_too_long_to_read",
}


def start_ingest_process() -> None:
    """Nothing to open: ingest writes to the database from the worker's own process."""


def prepare_ad_audio_in_process(file_bytes: bytes) -> dict[str, Any]:
    """Decode to the canonical form, check the length, then fingerprint (only if the length is right).

    Returns {"refusal_reason": …} or {"duration_milliseconds", "hashes", "time_offset_frames"}.
    """
    parameters = FingerprintParameters()
    try:
        samples = decode_audio(file_bytes, parameters.sample_rate, maximum_seconds=DECODE_LIMIT_SECONDS,
                               maximum_bytes=MAXIMUM_UPLOAD_BYTES, deadline_seconds=AD_DECODE_SECONDS)
    except DecodeError as refused:
        return {"refusal_reason": _DECODE_REFUSALS.get(refused.code, "audio_unreadable")}
    sample_count = len(samples)
    if sample_count < MINIMUM_AD_SECONDS * parameters.sample_rate:
        return {"refusal_reason": "audio_too_short"}
    if sample_count > MAXIMUM_AD_SECONDS * parameters.sample_rate:
        return {"refusal_reason": "audio_too_long"}
    ad_fingerprint = fingerprint(samples, parameters)
    return {
        "duration_milliseconds": round(sample_count * 1000 / parameters.sample_rate),
        "hashes": ad_fingerprint.hashes,
        "time_offset_frames": ad_fingerprint.time_offset_frames,
        "frame_count": ad_fingerprint.frame_count,
    }


def ready() -> bool:
    """Used to start the pool's processes ahead of the first job."""
    return True
