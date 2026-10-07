from __future__ import annotations

import av
import numpy as np
import pytest

from bench.synthetic_audio import PHONE_SAMPLE_RATE, SOURCE_SAMPLE_RATE, synthesize_ad, write_aac, write_wav
from lookup_fingerprint import DecodeError, decode_audio


def _decode_error(**decode_arguments) -> DecodeError:
    with pytest.raises(DecodeError) as exception_information:
        decode_audio(**decode_arguments)
    return exception_information.value


def test_decodes_phone_aac_to_canonical_rate(tmp_path):
    path = tmp_path / "clip.m4a"
    write_aac(path, synthesize_ad(1, 3.0, sample_rate=PHONE_SAMPLE_RATE), PHONE_SAMPLE_RATE, 24_000)
    samples = decode_audio(path, 11025)
    assert samples.dtype == np.float32
    assert abs(samples.size - 3 * 11025) <= 2048        # AAC priming/padding tolerance


def test_garbage_bytes_are_rejected_with_a_code():
    error = _decode_error(source=b"definitely not audio " * 200, sample_rate=11025)
    assert error.code in {"DECODE_FAILED", "UNSUPPORTED_FORMAT"}


def test_error_text_is_only_the_code():
    """str(error) must be safe to surface by accident: the code, never ffmpeg internals."""
    error = _decode_error(source=b"\x00" * 4096, sample_rate=11025)
    assert str(error) == error.code


def test_byte_cap(tmp_path):
    path = tmp_path / "big.wav"
    write_wav(path, np.zeros(PHONE_SAMPLE_RATE * 2, np.float32), PHONE_SAMPLE_RATE)
    assert _decode_error(source=path, sample_rate=11025, maximum_bytes=1000).code == "AUDIO_TOO_LARGE"


def test_duration_cap(tmp_path):
    path = tmp_path / "long.wav"
    write_wav(path, synthesize_ad(2, 3.0, sample_rate=PHONE_SAMPLE_RATE), PHONE_SAMPLE_RATE)
    assert _decode_error(source=path, sample_rate=11025, maximum_seconds=1.0).code == "AUDIO_TOO_LONG"


def test_container_whitelist(tmp_path):
    path = tmp_path / "clip.aiff"
    with av.open(str(path), mode="w", format="aiff") as container:
        stream = container.add_stream("pcm_s16be", rate=PHONE_SAMPLE_RATE, layout="mono")
        pcm_samples = (synthesize_ad(3, 1.0, sample_rate=PHONE_SAMPLE_RATE) * 32767).astype(np.int16).reshape(1, -1)
        frame = av.AudioFrame.from_ndarray(pcm_samples, format="s16", layout="mono")
        frame.sample_rate = PHONE_SAMPLE_RATE
        for packet in stream.encode(frame):
            container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
    assert _decode_error(source=path, sample_rate=11025).code == "UNSUPPORTED_FORMAT"


def test_the_demuxer_comes_from_the_files_own_first_bytes_never_a_guess(monkeypatch, tmp_path):
    """ffmpeg would otherwise run whichever demuxer it guessed, header code and all, before the
    allow-list could refuse it."""
    import av as pyav

    opened_with: list[str | None] = []
    real_open = pyav.open

    def spying_open(handle, *arguments, **options):
        opened_with.append(options.get("format"))
        return real_open(handle, *arguments, **options)

    monkeypatch.setattr(pyav, "open", spying_open)
    samples = synthesize_ad(3, 2.0)
    write_wav(tmp_path / "clip.wav", samples, SOURCE_SAMPLE_RATE)
    decode_audio((tmp_path / "clip.wav").read_bytes(), 8000)
    # An ID3 tag in front of a playlist is read as MP3 (and fails as audio), never as a playlist.
    with pytest.raises(DecodeError):
        decode_audio(b"ID3\x04\x00\x00\x00\x00\x00\x00#EXTM3U\n#EXT-X-TARGETDURATION:1\nfile:///etc/passwd\n" * 4, 8000)
    assert opened_with == ["wav", "mp3"]


def test_a_file_with_no_audio_signature_never_reaches_ffmpeg(monkeypatch):
    import av as pyav

    def must_not_open(*arguments, **options):
        raise AssertionError("ffmpeg was asked to open a file with no audio signature")

    monkeypatch.setattr(pyav, "open", must_not_open)
    for not_audio in (b"#EXTM3U\n#EXT-X-VERSION:3\nhttp://example.invalid/a.ts\n", b"ffconcat version 1.0\nfile x\n", b"<?xml version='1.0'?><MPD/>", b"\x89PNG\r\n\x1a\n"):
        with pytest.raises(DecodeError) as refused:
            decode_audio(not_audio * 8, 8000)
        assert refused.value.code == "UNSUPPORTED_FORMAT"
