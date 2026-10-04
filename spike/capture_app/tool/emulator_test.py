"""End-to-end test of the Look Up Capture RELEASE APK on an Android emulator — no phone needed.

Installs the APK (without pre-granting anything), drives the real UI through adb + uiautomator
like a person would, records clips, pulls them off the device and checks every file with the
Phase 0 decoder, then imports the session into a scratch benchmark corpus.

Run with the fingerprinter's Python (it needs PyAV and the `bench` package):
  ..\\..\\services\\fingerprinter\\.venv\\Scripts\\python.exe tool\\emulator_test.py \\
      --apk build\\app\\outputs\\flutter-apk\\app-x86_64-release.apk --out <folder for screenshots>
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

PKG = "zm.lookup.lookup_capture"
SESSIONS = f"/sdcard/Android/data/{PKG}/files/sessions"
ADB = os.environ.get("ADB") or str(Path(os.environ.get("LOCALAPPDATA", "")) / "Android/Sdk/platform-tools/adb.exe")


@dataclass
class Node:
    text: str
    desc: str
    hint: str
    cls: str
    pkg: str
    checked: bool
    x: int
    y: int
    top: int = 0
    bottom: int = 0

    @property
    def label(self) -> str:
        return " | ".join(v for v in (self.text, self.desc, self.hint) if v)


class Device:
    def __init__(self, shots: Path) -> None:
        self.shots = shots
        self.shot_no = 0

    def adb(self, *args: str, check: bool = True) -> str:
        out = subprocess.run([ADB, *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
        if check and out.returncode != 0:
            raise RuntimeError(f"adb {' '.join(args)} failed: {out.stderr.strip() or out.stdout.strip()}")
        return out.stdout

    def nodes(self) -> list[Node]:
        raw = self.adb("exec-out", "uiautomator", "dump", "/dev/tty", check=False)
        xml = raw[: raw.rfind("</hierarchy>") + len("</hierarchy>")] if "</hierarchy>" in raw else ""
        if not xml:
            return []
        found = []
        for el in ET.fromstring(xml).iter("node"):
            nums = [int(n) for n in re.findall(r"\d+", el.get("bounds", "[0,0][0,0]"))]
            found.append(Node(el.get("text", ""), el.get("content-desc", ""), el.get("hint", ""), el.get("class", ""),
                              el.get("package", ""), el.get("checked") == "true",
                              (nums[0] + nums[2]) // 2, (nums[1] + nums[3]) // 2, nums[1], nums[3]))
        return found

    def find(self, pattern: str, timeout: float = 8.0, scroll: bool = False, pkg: str | None = None) -> Node | None:
        rx = re.compile(pattern, re.I)
        deadline = time.monotonic() + timeout
        swipes = 0
        while True:
            for n in self.nodes():
                if rx.search(n.label) and (pkg is None or n.pkg == pkg):
                    return n
            if time.monotonic() > deadline:
                if scroll and swipes < 6:          # look further down the list, then back up
                    self.swipe(up=swipes < 3)
                    swipes += 1
                    continue
                return None
            time.sleep(0.4)

    def screen(self) -> tuple[int, int]:
        """(width in px, density in dpi)."""
        width = int(re.search(r"(\d+)x\d+", self.adb("shell", "wm", "size")).group(1))
        density = int(re.search(r"(\d+)\s*$", self.adb("shell", "wm", "density").strip()).group(1))
        return width, density

    def wake(self) -> None:
        """Wake the screen and dismiss a non-secure lock screen (it hides the app and blanks screenshots)."""
        self.adb("shell", "input", "keyevent", "224", check=False)
        self.adb("shell", "wm", "dismiss-keyguard", check=False)
        time.sleep(1)

    def swipe(self, up: bool) -> None:
        y1, y2 = (1500, 700) if up else (700, 1500)
        self.adb("shell", "input", "swipe", "540", str(y1), "540", str(y2), "250")
        time.sleep(0.6)

    def to_top(self) -> None:
        for _ in range(3):
            self.swipe(up=False)

    def tap(self, node: Node) -> None:
        self.adb("shell", "input", "tap", str(node.x), str(node.y))
        time.sleep(0.5)

    def type_into(self, node: Node, text: str) -> bool:
        """Type into a field and confirm the text landed (a cold keyboard can swallow the first keys)."""
        ok = False
        # Flutter reports a text field's box as its whole section (title + field + what follows);
        # the field itself sits about a third of the way down.
        tap_y = node.top + int((node.bottom - node.top) * 0.32) if node.bottom - node.top > 300 else node.y
        for _ in range(3):
            self.adb("shell", "input", "tap", str(node.x), str(tap_y))
            time.sleep(1.2)
            self.adb("shell", "input", "keycombination", "113", "29", check=False)   # Ctrl+A …
            self.adb("shell", "input", "keyevent", "67", check=False)                # … then delete
            self.adb("shell", "input", "text", text.replace(" ", "%s"))
            time.sleep(0.8)
            ok = any(n.cls.endswith("EditText") and text in n.text and abs(n.y - node.y) < 150 for n in self.nodes())
            if ok:
                break
        self.adb("shell", "input", "keyevent", "111")   # ESC: close the keyboard
        time.sleep(0.4)
        return ok

    def screenshot(self, name: str) -> Path:
        self.shot_no += 1
        path = self.shots / f"{self.shot_no:02d}-{name}.png"
        with path.open("wb") as fh:
            subprocess.run([ADB, "exec-out", "screencap", "-p"], stdout=fh, check=True)
        return path


class Report:
    def __init__(self) -> None:
        self.results: list[tuple[bool, str, str]] = []

    def check(self, ok: bool, name: str, detail: str = "") -> bool:
        self.results.append((ok, name, detail))
        print(f"{'PASS' if ok else 'FAIL'}  {name}{('  — ' + detail) if detail else ''}", flush=True)
        return ok

    @property
    def failed(self) -> int:
        return sum(1 for ok, _, _ in self.results if not ok)


def select(dev: Device, pattern: str) -> bool:
    dev.to_top()
    node = dev.find(pattern, scroll=True)
    if node:
        dev.tap(node)
    return node is not None


def set_switch(dev: Device, rep: Report, pattern: str, on: bool) -> None:
    """Put a switch into a known state (never blindly toggle — the starting state may differ)."""
    dev.to_top()
    node = dev.find(pattern, scroll=True)
    if node and node.checked != on:
        dev.tap(node)
        node = dev.find(pattern, timeout=2, scroll=True)
    rep.check(node is not None and node.checked == on, f"Switch '{pattern}' is {'on' if on else 'off'}")


RECORD_BTN = r"^Record (\d+ × )?\d+ s$"


def go_tab(dev: Device, name: str) -> bool:
    """Tap a bottom navigation tab ('Record' or 'Recordings')."""
    node = (dev.find(rf"(^|\n){name}\n[\s\S]*Tab \d of \d", timeout=3, pkg=PKG)
            or dev.find(rf"(^|\n){name}$", timeout=2, pkg=PKG))
    if node:
        dev.tap(node)
        time.sleep(0.6)
    return node is not None


def wait_gone(dev: Device, pattern: str, timeout: float) -> bool:
    rx = re.compile(pattern, re.I)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not any(rx.search(n.label) for n in dev.nodes()):
            return True
        time.sleep(0.5)
    return False


def record(dev: Device, rep: Report, label: str, seconds: float, expect: str, first: bool = False) -> bool:
    button = dev.find(RECORD_BTN, pkg=PKG)
    if not rep.check(button is not None, f"{label}: Record button visible", button.label if button else ""):
        return False
    dev.tap(button)
    if first:
        permission = dev.find(r"While using the app|^Allow$", timeout=6)
        asked = permission is not None and permission.pkg != PKG
        rep.check(asked, "Microphone permission prompt shown on first use", permission.pkg if permission else "")
        if asked:
            dev.screenshot("permission-prompt")
            dev.tap(permission)
    # The recording bar redraws many times a second, which uiautomator cannot read ("not idle"),
    # so keep a picture of it instead of asserting on its text.
    time.sleep(1.2)
    dev.screenshot(f"recording-{label}")
    done = dev.find(expect, timeout=seconds + 15, scroll=True)
    return rep.check(done is not None, f"{label}: result message", done.label if done else f"expected /{expect}/")


def verify_session(rep: Report, folder: Path, expected: list[dict]) -> None:
    import av

    part = folder / "manifest.part.csv"
    if not rep.check(part.is_file(), "Session folder contains manifest.part.csv"):
        return
    rows = list(csv.DictReader(part.open(encoding="utf-8")))
    header = list(rows[0].keys()) if rows else []
    rep.check(header == ["role", "path", "ad_id", "device", "scene", "clip_s", "codec", "ref_variant", "mic", "notes"],
              "Manifest columns match the benchmark", ",".join(header))
    rep.check(len(rows) == len(expected), "One manifest row per saved clip (cancelled clip not listed)",
              f"{len(rows)} rows, expected {len(expected)}")
    clips = sorted(folder.glob("*.m4a"))
    rep.check(len(clips) == len(expected), "Clip files on the phone match the manifest (no half clips left)",
              f"{len(clips)} files")
    for row, want in zip(rows, expected):
        path = folder / row["path"]
        try:
            with av.open(str(path)) as c:
                s = c.streams.audio[0]
                rate, channels, codec = s.codec_context.sample_rate, s.codec_context.channels, s.codec_context.name
                duration = float(c.duration or 0) / 1_000_000
            size_kb = path.stat().st_size / 1024
        except Exception as exc:  # report, keep checking the others
            rep.check(False, f"{row['path']}: decodes", type(exc).__name__)
            continue
        # Raw clips may run up to ~1.5 s long on a slow device; the import step trims them (checked below).
        ok = (codec == "aac" and rate == 16000 and channels == 1
              and want["clip_s"] - 0.3 <= duration <= want["clip_s"] + 1.5
              and row["role"] == want["role"] and row["mic"] == want["mic"] and row["clip_s"] == str(want["clip_s"]))
        rep.check(ok, f"{row['path'][:58]}…",
                  f"{codec} {rate} Hz {channels} ch, {duration:.2f} s (want {want['clip_s']}), {size_kb:.1f} KB, "
                  f"role={row['role']}, mic={row['mic']}")


def import_into_scratch_corpus(rep: Report, session: Path) -> None:
    import shutil

    from bench.import_captures import import_session
    from bench.manifest import load_manifest
    from bench.synth import SOURCE_RATE, synth_ad, write_wav

    corpus = Path(tempfile.mkdtemp(prefix="corpus_"))
    write_wav(corpus / "ref.wav", synth_ad(1, 6.0), SOURCE_RATE)
    manifest = corpus / "manifest.csv"
    manifest.write_text("role,path,ad_id,codec,ref_variant\nreference,ref.wav,brand-a,wav,master\n", encoding="utf-8")
    target = corpus / "captures" / session.name
    shutil.copytree(session, target)
    added = import_session(target, manifest)
    entries = load_manifest(manifest)
    rep.check(added > 0 and len(entries) == added + 1, "Session imports into the benchmark corpus and validates",
              f"{added} clips imported")
    import av

    lengths = []
    for e in entries:
        if e.role != "reference" and e.clip_s:
            with av.open(str(e.path)) as c:
                lengths.append((float(c.duration or 0) / 1_000_000, e.clip_s))
    rep.check(bool(lengths) and all(want - 0.3 <= got <= want + 0.1 for got, want in lengths),
              "After import every clip is its labelled length", ", ".join(f"{got:.2f}/{want:g} s" for got, want in lengths))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True, help="folder for screenshots and pulled sessions")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    dev, rep = Device(args.out), Report()

    dev.adb("uninstall", PKG, check=False)
    dev.adb("install", str(args.apk))                     # no -g: the permission prompt must appear
    rep.check(True, f"Installed {args.apk.name} (release build, no pre-granted permissions)")
    opened = None
    for _ in range(3):   # a lock screen or a freshly booted launcher can hide the app
        dev.wake()
        dev.adb("shell", "am", "start", "-W", "-n", f"{PKG}/.MainActivity")
        opened = dev.find(r"Look Up Capture", timeout=10, pkg=PKG)   # inside the app, not its launcher icon
        if opened:
            break
    if not rep.check(opened is not None, "App opens on the capture screen"):
        dev.screenshot("did-not-open")
        return 1
    dev.screenshot("home")
    rep.check(dev.find(r"How it works", timeout=3, pkg=PKG) is not None, "Explains how to use it on first open")

    # 0. Navigation: the Recordings tab exists, says what to do when empty, and leads back.
    rep.check(go_tab(dev, "Recordings"), "Recordings tab reachable from the bottom bar")
    rep.check(dev.find(r"No recordings yet", timeout=4) is not None, "Empty Recordings tab explains what to do")
    dev.screenshot("recordings-empty")
    back = dev.find(r"^Go to Record$", timeout=3)
    if back:
        dev.tap(back)
    rep.check(dev.find(RECORD_BTN, timeout=4, pkg=PKG) is not None, "'Go to Record' leads back to the Record tab")

    # 1. Validation: plain-language messages before anything is recorded.
    first = dev.find(RECORD_BTN, pkg=PKG)
    if not rep.check(first is not None, "Record button visible on first open"):
        dev.screenshot("no-record-button")
        return 1
    dev.tap(first)
    rep.check(dev.find(r"phone model first", timeout=4) is not None, "Refuses to record without a phone model")
    dev.screenshot("validation")
    fields = [n for n in dev.nodes() if n.cls.endswith("EditText")]
    phone = dev.find(r"Phone model", timeout=2) or (fields[1] if len(fields) > 1 else None)
    if not rep.check(phone is not None, "Phone model field found"):
        return 1
    if not rep.check(dev.type_into(phone, "emulator-test"), "Phone model typed into its field"):
        dev.screenshot("typing-failed")
        return 1
    dev.tap(dev.find(RECORD_BTN, pkg=PKG))
    rep.check(dev.find(r"Enter the ad id", timeout=4) is not None, "Refuses to record without an ad id")
    dev.to_top()
    fields = [n for n in dev.nodes() if n.cls.endswith("EditText")]
    ad = dev.find(r"Ad id", timeout=2) or (fields[0] if fields else None)
    if not rep.check(ad is not None, "Ad id field found"):
        return 1
    if not rep.check(dev.type_into(ad, "brand-a"), "Ad id typed into its field"):
        dev.screenshot("typing-failed")
        return 1

    expected: list[dict] = []
    set_switch(dev, rep, r"^Noise suppression", False)
    set_switch(dev, rep, r"^Auto gain", False)
    set_switch(dev, rep, r"^Not an ad", False)
    # 2. One 3 s clip with the default mic settings (also exercises the permission prompt).
    select(dev, r"^3 s$")
    if record(dev, rep, "3s-default", 3, r"Saved 1 clip", first=True):
        expected.append({"clip_s": 3, "role": "query", "mic": "mic/ns-off/agc-off"})
    dev.screenshot("saved-one")

    # 2b. Listen straight after recording: 'Listen to it' → Recordings tab → Play → it finishes.
    listen = dev.find(r"Listen to it", timeout=4, scroll=True)
    rep.check(listen is not None, "'Listen to it' offered right after recording")
    if listen:
        dev.tap(listen)
    rep.check(dev.find(r"Current session · 1 recording\b", timeout=5) is not None,
              "Recordings tab shows the new clip in the current session")
    play = dev.find(r"^Play$", timeout=4)
    if rep.check(play is not None, "Each clip has a Play button"):
        dev.tap(play)
        started = dev.find(r"Playing…|^Stop$", timeout=4)
        rep.check(started is not None, "Tapping Play plays the clip", started.label if started else "")
        dev.screenshot("playing")
        rep.check(wait_gone(dev, r"Playing…", timeout=10) and dev.find(r"^Play$", timeout=3) is not None,
                  "Playback finishes and the button returns to Play")
    rep.check(go_tab(dev, "Record"), "Record tab reachable again from the bottom bar")

    # 3. Cancel half way: the partial clip must be deleted and not listed.
    select(dev, r"^10 s$")
    start = dev.find(RECORD_BTN, pkg=PKG)
    if not rep.check(start is not None, "Record button visible before the cancel test"):
        dev.screenshot("no-record-button-2")
        return 1
    dev.tap(start)
    time.sleep(2.5)
    dev.screenshot("recording-before-cancel")
    # Cancel sits at the right end of the bottom bar (16 dp margin, 88 dp wide), level with Record.
    width, density = dev.screen()
    dev.adb("shell", "input", "tap", str(width - round(60 * density / 160)), str(start.y))
    rep.check(dev.find(r"unfinished clip was deleted", timeout=8, scroll=True) is not None,
              "Cancel stops the recording and deletes the unfinished clip")

    # 4. Two takes back to back.
    select(dev, r"^3 s$")
    select(dev, r"2 takes in a row")
    if record(dev, rep, "two-takes", 6, r"Saved 2 clip"):
        expected += [{"clip_s": 3, "role": "query", "mic": "mic/ns-off/agc-off"}] * 2

    # 5. Different mic source + noise suppression, single take.
    select(dev, r"^1 take$")
    select(dev, r"voiceRecognition")
    set_switch(dev, rep, r"^Noise suppression", True)
    if record(dev, rep, "voicerec-ns", 3, r"Saved 1 clip"):
        expected.append({"clip_s": 3, "role": "query", "mic": "voiceRecognition/ns-on/agc-off"})

    # 6. A negative clip ("not an ad").
    set_switch(dev, rep, r"^Not an ad", True)
    if record(dev, rep, "negative", 3, r"Saved 1 clip"):
        expected.append({"clip_s": 3, "role": "negative", "mic": "voiceRecognition/ns-on/agc-off"})
    dev.screenshot("after-negative")

    # 7. The 'unprocessed' source is missing on some phones: it must fail politely, never crash.
    select(dev, r"^unprocessed$")
    record(dev, rep, "unprocessed", 3, r"Saved 1 clip|Recording stopped on this phone")
    unprocessed_ok = dev.find(r"Saved 1 clip", timeout=1, scroll=True) is not None
    if unprocessed_ok:
        expected.append({"clip_s": 3, "role": "negative", "mic": "unprocessed/ns-on/agc-off"})
    rep.check(dev.find(r"Look Up Capture", timeout=3) is not None, "App still running after the unprocessed-source attempt")

    # 7b. Recordings tab lists everything; delete removes a clip and its label row.
    rep.check(go_tab(dev, "Recordings"), "Back to Recordings")
    n = len(expected)
    rep.check(dev.find(rf"Current session · {n} recordings?\b", timeout=5) is not None,
              f"Current session lists all {n} saved clips")
    delete = dev.find(r"^Delete$", timeout=4)
    if rep.check(delete is not None, "Each clip has a Delete button"):
        dev.tap(delete)
        rep.check(dev.find(r"Delete this recording\?", timeout=4) is not None, "Delete asks for confirmation first")
        dev.screenshot("delete-confirm")
        confirm = dev.find(r"^Delete$", timeout=3)
        if confirm:
            dev.tap(confirm)
        if rep.check(dev.find(r"Recording deleted", timeout=5) is not None, "Clip deleted after confirming"):
            expected.pop()                       # the list is newest first; the newest clip was deleted
        rep.check(dev.find(rf"Current session · {len(expected)} recordings?\b", timeout=5) is not None,
                  "Count updates after deleting")

    # 8. Send to computer: the share sheet gets the session files.
    dev.to_top()
    share = dev.find(r"^Send to computer$", timeout=4)
    rep.check(share is not None, "'Send to computer' button shown once clips exist")
    if share:
        dev.adb("logcat", "-c", check=False)
        dev.tap(share)
        sheet = None
        asked = ""
        deadline = time.monotonic() + 10
        while sheet is None and not asked and time.monotonic() < deadline:
            sheet = next((n for n in dev.nodes() if n.pkg and n.pkg != PKG), None)
            log = dev.adb("logcat", "-d", check=False)
            asked = next((line.strip()[:160] for line in log.splitlines()
                          if "android.intent.action.CHOOSER" in line or "android.intent.action.SEND" in line), "")
            time.sleep(0.5)
        # Stripped-down test images have no apps to share to, so the sheet may never draw;
        # what matters is that the app handed Android a share request with the files.
        rep.check(sheet is not None or bool(asked), "Share hands the session to Android's share sheet",
                  (sheet.pkg if sheet else "") or asked)
        dev.screenshot("share-sheet")
        dev.adb("shell", "input", "keyevent", "4")
        time.sleep(1)

    # 8b. Close and reopen the app: recordings must still be there.
    dev.adb("shell", "am", "force-stop", PKG)
    dev.wake()
    dev.adb("shell", "am", "start", "-W", "-n", f"{PKG}/.MainActivity")
    dev.find(r"Look Up Capture", timeout=10, pkg=PKG)
    go_tab(dev, "Recordings")
    rep.check(dev.find(rf"Current session · {len(expected)} recordings?\b", timeout=6) is not None,
              "Recordings are still there after closing and reopening the app")

    # 8c. New session: old clips move under 'Earlier sessions', new recordings start fresh.
    new = dev.find(r"^Start new session$", timeout=4, scroll=True)
    if rep.check(new is not None, "'Start new session' button shown"):
        dev.tap(new)
        rep.check(dev.find(r"Start a new session\?", timeout=4) is not None, "New session explains itself and asks first")
        dev.screenshot("new-session-confirm")
        confirm = dev.find(r"^Start new session$", timeout=3)
        if confirm:
            dev.tap(confirm)
        rep.check(dev.find(r"Current session · 0 recordings", timeout=6) is not None, "New session starts empty")
        rep.check(dev.find(r"Earlier sessions", timeout=4, scroll=True) is not None
                  and dev.find(rf"· {len(expected)} recordings?\b", timeout=4, scroll=True) is not None,
                  "Earlier session still listed with its clips")
        dev.screenshot("after-new-session")

    # 9. Pull the sessions off the device and verify every file with the Phase 0 decoder.
    listing = dev.adb("shell", "ls", SESSIONS, check=False).split()
    sessions = sorted(s for s in listing if s.startswith("session_"))
    rep.check(len(sessions) == 2, "Two session folders on the device (recorded + new empty one)", " ".join(sessions))
    if sessions:
        dev.adb("pull", f"{SESSIONS}/{sessions[0]}", str(args.out))
        local = args.out / sessions[0]
        verify_session(rep, local, expected)
        import_into_scratch_corpus(rep, local)

    print(f"\n{len(rep.results) - rep.failed} passed, {rep.failed} failed · screenshots in {args.out}")
    return 1 if rep.failed else 0


if __name__ == "__main__":
    sys.exit(main())
