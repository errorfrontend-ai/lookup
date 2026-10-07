"""Decode untrusted audio to mono float32 at the canonical sample rate.

Uploads are untrusted input to ffmpeg, so decoding is fenced in: container whitelist,
byte cap, duration cap, optional wall-clock deadline, first audio stream only. PyAV
bundles its own ffmpeg libraries, so no system ffmpeg is required.

Errors carry a stable `code`. Callers relay the code (mapped to a public message by the
API's error catalogue) and log `detail` privately — never the exception text itself.
"""

from __future__ import annotations

import io
import time
from pathlib import Path

import av
import numpy as np

# PyAV/ffmpeg demuxer names we accept (MP4/M4A/3GP from phones, Ogg/WebM Opus, WAV, MP3, ADTS AAC, FLAC).
ALLOWED_FORMATS = frozenset({
    "mov,mp4,m4a,3gp,3g2,mj2",
    "ogg",
    "matroska,webm",
    "wav",
    "mp3",
    "aac",
    "flac",
})


def demuxer_for(first_bytes: bytes) -> str | None:
    """The one demuxer a file's own first bytes allow, or None. ffmpeg is never left to guess the
    format: a guessed demuxer would run its header code (some can open other resources) before the
    allow-list could refuse it, and a file could pass a signature check as one format and be read as
    another (an ID3 tag in front of something that is not MP3, say)."""
    if first_bytes[4:8] == b"ftyp":
        return "mov"
    if first_bytes.startswith(b"OggS"):
        return "ogg"
    if first_bytes.startswith(b"\x1a\x45\xdf\xa3"):
        return "matroska"
    if first_bytes.startswith(b"RIFF") and first_bytes[8:12] == b"WAVE":
        return "wav"
    if first_bytes.startswith(b"fLaC"):
        return "flac"
    if first_bytes.startswith(b"ID3"):
        return "mp3"
    if len(first_bytes) >= 2 and first_bytes[0] == 0xFF and first_bytes[1] & 0xE0 == 0xE0:
        # MPEG audio frame sync: layer bits 00 is ADTS AAC, anything else is MP3.
        return "aac" if first_bytes[1] & 0x06 == 0 else "mp3"
    return None


ALLOWED_DEMUXERS = frozenset(name.split(",")[0] for name in ALLOWED_FORMATS)


class DecodeError(Exception):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail


def decode_audio(
    source: str | Path | bytes,
    sample_rate: int,
    *,
    maximum_seconds: float = 150.0,
    maximum_bytes: int = 25 * 1024 * 1024,
    deadline_seconds: float | None = None,
) -> np.ndarray:
    started_at = time.monotonic()
    if isinstance(source, (bytes, bytearray)):
        if len(source) > maximum_bytes:
            raise DecodeError("AUDIO_TOO_LARGE", f"{len(source)} bytes")
        first_bytes = bytes(source[:16])
        handle: object = io.BytesIO(source)
    else:
        path = Path(source)
        size_bytes = path.stat().st_size
        if size_bytes > maximum_bytes:
            raise DecodeError("AUDIO_TOO_LARGE", f"{size_bytes} bytes")
        with path.open("rb") as file:
            first_bytes = file.read(16)
        handle = str(path)

    demuxer = demuxer_for(first_bytes)
    if demuxer is None:
        raise DecodeError("UNSUPPORTED_FORMAT", "no known audio signature")
    try:
        container = av.open(handle, mode="r", format=demuxer)
    except av.error.FFmpegError as error:
        raise DecodeError("DECODE_FAILED", type(error).__name__) from error

    chunks: list[np.ndarray] = []
    total_samples = 0
    maximum_samples = int(maximum_seconds * sample_rate)
    with container:
        # A second guard: whatever ffmpeg opened must be one of ours (named by its first alias when
        # opened by name, by its full alias list when guessed).
        if container.format.name not in ALLOWED_FORMATS and container.format.name.split(",")[0] not in ALLOWED_DEMUXERS:
            raise DecodeError("UNSUPPORTED_FORMAT", container.format.name)
        if not container.streams.audio:
            raise DecodeError("NO_AUDIO_STREAM")
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="flt", layout="mono", rate=sample_rate)
        try:
            for frame in container.decode(stream):
                for resampled_frame in resampler.resample(frame):
                    chunk = resampled_frame.to_ndarray().reshape(-1)
                    chunks.append(chunk)
                    total_samples += chunk.size
                if total_samples > maximum_samples:
                    raise DecodeError("AUDIO_TOO_LONG", f"> {maximum_seconds}s")
                if deadline_seconds is not None and time.monotonic() - started_at > deadline_seconds:
                    raise DecodeError("DECODE_TIMEOUT", f"> {deadline_seconds}s")
            for resampled_frame in resampler.resample(None):   # flush the resampler's tail
                chunk = resampled_frame.to_ndarray().reshape(-1)
                chunks.append(chunk)
                total_samples += chunk.size
        except av.error.FFmpegError as error:
            raise DecodeError("DECODE_FAILED", type(error).__name__) from error

    if total_samples == 0:
        raise DecodeError("EMPTY_AUDIO")
    return np.concatenate(chunks).astype(np.float32, copy=False)
