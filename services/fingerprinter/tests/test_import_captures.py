from __future__ import annotations

import csv

import pytest

from bench.import_captures import import_session
from bench.manifest import load_manifest
from bench.synth import PHONE_RATE, SOURCE_RATE, synth_ad, write_aac, write_wav


def _corpus_with_old_header(tmp_path):
    """A manifest written before the `mic` column existed."""
    tmp_path.mkdir(parents=True, exist_ok=True)
    write_wav(tmp_path / "ref.wav", synth_ad(1, 6.0), SOURCE_RATE)
    manifest = tmp_path / "manifest.csv"
    manifest.write_text("role,path,ad_id,device,scene,clip_s,codec,ref_variant,notes\n"
                        "reference,ref.wav,brand-a,,,,wav,master,\n", encoding="utf-8")
    return manifest


def _phone_session(root):
    """What the capture app writes: clips + manifest.part.csv with paths relative to the folder."""
    session = root / "session_20260930T070509"
    session.mkdir(parents=True)
    write_aac(session / "clip1.m4a", synth_ad(1, 3.0, sample_rate=PHONE_RATE), PHONE_RATE, 24_000)
    (session / "manifest.part.csv").write_text(
        "role,path,ad_id,device,scene,clip_s,codec,ref_variant,mic,notes\n"
        "query,clip1.m4a,brand-a,itel-a70-a13,vehicle,8,aac24,,mic/ns-off/agc-off,captured 2026-09-30T07:05:09\n",
        encoding="utf-8",
    )
    return session


def test_import_merges_session_and_widens_old_header(tmp_path):
    manifest = _corpus_with_old_header(tmp_path)
    session = _phone_session(tmp_path / "captures")

    assert import_session(session, manifest) == 1
    assert import_session(session, manifest) == 0                   # re-running is safe

    rows = list(csv.DictReader(manifest.open(encoding="utf-8")))
    assert "mic" in rows[0]                                          # header widened, old row kept
    assert [row["path"] for row in rows] ==["ref.wav", "captures/session_20260930T070509/clip1.m4a"]
    query = [entry for entry in load_manifest(manifest) if entry.role == "query"][0]
    assert query.mic == "mic/ns-off/agc-off" and query.device == "itel-a70-a13"


def test_overlong_clip_is_cut_to_its_labelled_length(tmp_path):
    """A '3 s' clip that really lasts 4 s must not reach the benchmark at 4 s."""
    import av

    from lookup_fingerprint import decode_audio

    manifest = _corpus_with_old_header(tmp_path)
    session = tmp_path / "captures" / "session_x"
    session.mkdir(parents=True)
    write_aac(session / "long.m4a", synth_ad(1, 4.0, sample_rate=PHONE_RATE), PHONE_RATE, 24_000)
    write_aac(session / "exact.m4a", synth_ad(1, 3.0, sample_rate=PHONE_RATE), PHONE_RATE, 24_000)
    exact_before = (session / "exact.m4a").read_bytes()
    (session / "manifest.part.csv").write_text(
        "role,path,ad_id,device,scene,clip_s,codec,ref_variant,mic,notes\n"
        "query,long.m4a,brand-a,emu,quiet,3,aac24,,mic/ns-off/agc-off,captured\n"
        "query,exact.m4a,brand-a,emu,quiet,3,aac24,,mic/ns-off/agc-off,captured\n",
        encoding="utf-8",
    )

    assert import_session(session, manifest) == 2

    with av.open(str(session / "long.m4a")) as container:
        assert 2.85 <= float(container.duration) / av.time_base <= 3.1
    assert 2.8 * PHONE_RATE <= decode_audio(session / "long.m4a", PHONE_RATE).size <= 3.1 * PHONE_RATE
    assert (session / "exact.m4a").read_bytes() == exact_before          # already the right length: untouched
    rows = {row["path"].rsplit("/", 1)[-1]: row for row in csv.DictReader(manifest.open(encoding="utf-8"))}
    assert "trimmed to 3 s" in rows["long.m4a"]["notes"] and "trimmed" not in rows["exact.m4a"]["notes"]


def test_session_outside_the_corpus_is_refused(tmp_path):
    manifest = _corpus_with_old_header(tmp_path / "corpus")
    session = _phone_session(tmp_path / "downloads")
    with pytest.raises(SystemExit, match="inside"):
        import_session(session, manifest)
