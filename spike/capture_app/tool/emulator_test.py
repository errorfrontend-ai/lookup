"""End-to-end test of the Look Up Capture RELEASE APK on an Android emulator — no phone needed.

Installs the APK (without pre-granting anything), drives the real UI through adb + uiautomator
like a person would, records clips, pulls them off the device and checks every file with the
Phase 0 decoder, then imports the session into a scratch benchmark corpus.

Run with the fingerprinter's Python (it needs PyAV and the `bench` package):
  ..\\..\\services\\fingerprinter\\.venv\\Scripts\\python.exe tool\\emulator_test.py \\
      --apk build\\app\\outputs\\flutter-apk\\app-x86_64-release.apk --output-directory <folder for screenshots>
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
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree

APP_PACKAGE_NAME = "zm.lookup.lookup_capture"
SESSIONS_DIRECTORY_ON_DEVICE = f"/sdcard/Android/data/{APP_PACKAGE_NAME}/files/sessions"
ADB_EXECUTABLE = (os.environ.get("ADB")
                  or str(Path(os.environ.get("LOCALAPPDATA", "")) / "Android/Sdk/platform-tools/adb.exe"))


@dataclass
class Node:
    text: str
    content_description: str
    hint: str
    class_name: str
    package_name: str
    is_checked: bool
    center_x: int
    center_y: int
    top: int = 0
    bottom: int = 0

    @property
    def label(self) -> str:
        return " | ".join(value for value in (self.text, self.content_description, self.hint) if value)


class Device:
    def __init__(self, screenshot_directory: Path) -> None:
        self.screenshot_directory = screenshot_directory
        self.screenshot_count = 0

    def run_adb(self, *arguments: str, raise_on_failure: bool = True) -> str:
        completed = subprocess.run([ADB_EXECUTABLE, *arguments], capture_output=True, text=True, encoding="utf-8",
                                   errors="replace")
        if raise_on_failure and completed.returncode != 0:
            raise RuntimeError(
                f"adb {' '.join(arguments)} failed: {completed.stderr.strip() or completed.stdout.strip()}")
        return completed.stdout

    def read_nodes_on_screen(self) -> list[Node]:
        raw_dump = self.run_adb("exec-out", "uiautomator", "dump", "/dev/tty", raise_on_failure=False)
        hierarchy_xml = (raw_dump[: raw_dump.rfind("</hierarchy>") + len("</hierarchy>")]
                         if "</hierarchy>" in raw_dump else "")
        if not hierarchy_xml:
            return []
        nodes = []
        for element in ElementTree.fromstring(hierarchy_xml).iter("node"):
            bounds = [int(number) for number in re.findall(r"\d+", element.get("bounds", "[0,0][0,0]"))]
            nodes.append(Node(element.get("text", ""), element.get("content-desc", ""), element.get("hint", ""),
                              element.get("class", ""), element.get("package", ""), element.get("checked") == "true",
                              (bounds[0] + bounds[2]) // 2, (bounds[1] + bounds[3]) // 2, bounds[1], bounds[3]))
        return nodes

    def find_node(self, pattern: str, timeout_seconds: float = 8.0, scroll_if_not_found: bool = False,
                  package_name: str | None = None) -> Node | None:
        compiled_pattern = re.compile(pattern, re.IGNORECASE)
        deadline = time.monotonic() + timeout_seconds
        swipe_count = 0
        while True:
            for node in self.read_nodes_on_screen():
                if compiled_pattern.search(node.label) and (package_name is None or node.package_name == package_name):
                    return node
            if time.monotonic() > deadline:
                if scroll_if_not_found and swipe_count < 6:          # look further down the list, then back up
                    self.swipe_vertically(finger_moves_up=swipe_count < 3)
                    swipe_count += 1
                    continue
                return None
            time.sleep(0.4)

    def read_screen_width_and_density(self) -> tuple[int, int]:
        """(width in px, density in dpi)."""
        width_pixels = int(re.search(r"(\d+)x\d+", self.run_adb("shell", "wm", "size")).group(1))
        density_dpi = int(re.search(r"(\d+)\s*$", self.run_adb("shell", "wm", "density").strip()).group(1))
        return width_pixels, density_dpi

    def wake_screen(self) -> None:
        """Wake the screen and dismiss a non-secure lock screen (it hides the app and blanks screenshots)."""
        self.run_adb("shell", "input", "keyevent", "224", raise_on_failure=False)
        self.run_adb("shell", "wm", "dismiss-keyguard", raise_on_failure=False)
        time.sleep(1)

    def swipe_vertically(self, finger_moves_up: bool) -> None:
        start_y, end_y = (1500, 700) if finger_moves_up else (700, 1500)
        self.run_adb("shell", "input", "swipe", "540", str(start_y), "540", str(end_y), "250")
        time.sleep(0.6)

    def scroll_to_top(self) -> None:
        for _ in range(3):
            self.swipe_vertically(finger_moves_up=False)

    def tap(self, node: Node) -> None:
        self.run_adb("shell", "input", "tap", str(node.center_x), str(node.center_y))
        time.sleep(0.5)

    def type_into(self, node: Node, text: str) -> bool:
        """Type into a field and confirm the text landed (a cold keyboard can swallow the first keys)."""
        is_text_entered = False
        # Flutter reports a text field's box as its whole section (title + field + what follows);
        # the field itself sits about a third of the way down.
        tap_y = node.top + int((node.bottom - node.top) * 0.32) if node.bottom - node.top > 300 else node.center_y
        for _ in range(3):
            self.run_adb("shell", "input", "tap", str(node.center_x), str(tap_y))
            time.sleep(1.2)
            self.run_adb("shell", "input", "keycombination", "113", "29", raise_on_failure=False)   # Ctrl+A …
            self.run_adb("shell", "input", "keyevent", "67", raise_on_failure=False)                # … then delete
            self.run_adb("shell", "input", "text", text.replace(" ", "%s"))
            time.sleep(0.8)
            is_text_entered = any(on_screen.class_name.endswith("EditText") and text in on_screen.text
                                  and abs(on_screen.center_y - node.center_y) < 150
                                  for on_screen in self.read_nodes_on_screen())
            if is_text_entered:
                break
        self.run_adb("shell", "input", "keyevent", "111")   # ESC: close the keyboard
        time.sleep(0.4)
        return is_text_entered

    def take_screenshot(self, name: str) -> Path:
        self.screenshot_count += 1
        path = self.screenshot_directory / f"{self.screenshot_count:02d}-{name}.png"
        with path.open("wb") as screenshot_file:
            subprocess.run([ADB_EXECUTABLE, "exec-out", "screencap", "-p"], stdout=screenshot_file, check=True)
        return path


class Report:
    def __init__(self) -> None:
        self.results: list[tuple[bool, str, str]] = []

    def check(self, passed: bool, name: str, detail: str = "") -> bool:
        self.results.append((passed, name, detail))
        print(f"{'PASS' if passed else 'FAIL'}  {name}{('  — ' + detail) if detail else ''}", flush=True)
        return passed

    @property
    def failed_count(self) -> int:
        return sum(1 for passed, _, _ in self.results if not passed)


def select_option(device: Device, pattern: str) -> bool:
    device.scroll_to_top()
    node = device.find_node(pattern, scroll_if_not_found=True)
    if node:
        device.tap(node)
    return node is not None


def set_switch(device: Device, report: Report, pattern: str, should_be_on: bool) -> None:
    """Put a switch into a known state (never blindly toggle — the starting state may differ)."""
    device.scroll_to_top()
    node = device.find_node(pattern, scroll_if_not_found=True)
    if node and node.is_checked != should_be_on:
        device.tap(node)
        node = device.find_node(pattern, timeout_seconds=2, scroll_if_not_found=True)
    report.check(node is not None and node.is_checked == should_be_on,
                 f"Switch '{pattern}' is {'on' if should_be_on else 'off'}")


RECORD_BUTTON_PATTERN = r"^Record (\d+ × )?\d+ s$"


def go_to_tab(device: Device, tab_name: str) -> bool:
    """Tap a bottom navigation tab ('Record' or 'Recordings')."""
    node = (device.find_node(rf"(^|\n){tab_name}\n[\s\S]*Tab \d of \d", timeout_seconds=3,
                             package_name=APP_PACKAGE_NAME)
            or device.find_node(rf"(^|\n){tab_name}$", timeout_seconds=2, package_name=APP_PACKAGE_NAME))
    if node:
        device.tap(node)
        time.sleep(0.6)
    return node is not None


def wait_until_gone(device: Device, pattern: str, timeout_seconds: float) -> bool:
    compiled_pattern = re.compile(pattern, re.IGNORECASE)
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if not any(compiled_pattern.search(node.label) for node in device.read_nodes_on_screen()):
            return True
        time.sleep(0.5)
    return False


def record_clip(device: Device, report: Report, step_name: str, recording_seconds: float,
                expected_message_pattern: str, is_first_recording: bool = False) -> bool:
    button = device.find_node(RECORD_BUTTON_PATTERN, package_name=APP_PACKAGE_NAME)
    if not report.check(button is not None, f"{step_name}: Record button visible", button.label if button else ""):
        return False
    device.tap(button)
    if is_first_recording:
        permission = device.find_node(r"While using the app|^Allow$", timeout_seconds=6)
        is_permission_asked = permission is not None and permission.package_name != APP_PACKAGE_NAME
        report.check(is_permission_asked, "Microphone permission prompt shown on first use",
                     permission.package_name if permission else "")
        if is_permission_asked:
            device.take_screenshot("permission-prompt")
            device.tap(permission)
    # The recording bar redraws many times a second, which uiautomator cannot read ("not idle"),
    # so keep a picture of it instead of asserting on its text.
    time.sleep(1.2)
    device.take_screenshot(f"recording-{step_name}")
    result_message = device.find_node(expected_message_pattern, timeout_seconds=recording_seconds + 15,
                                      scroll_if_not_found=True)
    return report.check(result_message is not None, f"{step_name}: result message",
                        result_message.label if result_message else f"expected /{expected_message_pattern}/")


def verify_session(report: Report, session_directory: Path, expected_clips: list[dict]) -> None:
    import av

    from bench.manifest import MANIFEST_FIELDS, read_csv_with_current_column_names

    part_manifest = session_directory / "manifest.part.csv"
    if not report.check(part_manifest.is_file(), "Session folder contains manifest.part.csv"):
        return
    # The app under test must write the current column names, so check the header exactly as written
    # (no legacy mapping). The rows are then read the way the import reads them.
    with part_manifest.open(newline="", encoding="utf-8-sig") as part_manifest_file:
        header_as_written = next(csv.reader(part_manifest_file), [])
    report.check(header_as_written == MANIFEST_FIELDS, "Manifest columns match the benchmark", ",".join(header_as_written))
    _, rows = read_csv_with_current_column_names(part_manifest)
    report.check(len(rows) == len(expected_clips), "One manifest row per saved clip (cancelled clip not listed)",
                 f"{len(rows)} rows, expected {len(expected_clips)}")
    clip_files = sorted(session_directory.glob("*.m4a"))
    report.check(len(clip_files) == len(expected_clips),
                 "Clip files on the phone match the manifest (no half clips left)", f"{len(clip_files)} files")
    for row, expected_clip in zip(rows, expected_clips):
        clip_path = session_directory / row["path"]
        try:
            with av.open(str(clip_path)) as container:
                codec_context = container.streams.audio[0].codec_context
                sample_rate_hertz, channel_count = codec_context.sample_rate, codec_context.channels
                codec = codec_context.name
                duration_seconds = float(container.duration or 0) / 1_000_000
            size_kilobytes = clip_path.stat().st_size / 1024
        except Exception as error:  # report, keep checking the others
            report.check(False, f"{row['path']}: decodes", type(error).__name__)
            continue
        expected_seconds = expected_clip["clip_seconds"]
        # Raw clips may run up to ~1.5 s long on a slow device; the import step trims them (checked below).
        passed = (codec == "aac" and sample_rate_hertz == 16000 and channel_count == 1
                  and expected_seconds - 0.3 <= duration_seconds <= expected_seconds + 1.5
                  and row["role"] == expected_clip["role"]
                  and row["microphone_settings"] == expected_clip["microphone_settings"]
                  and row["clip_seconds"] == str(expected_seconds))
        report.check(passed, f"{row['path'][:58]}…",
                     f"{codec} {sample_rate_hertz} Hz {channel_count} ch, {duration_seconds:.2f} s "
                     f"(want {expected_seconds}), {size_kilobytes:.1f} KB, "
                     f"role={row['role']}, microphone_settings={row['microphone_settings']}")


def import_into_scratch_corpus(report: Report, session_directory: Path) -> None:
    import shutil

    from bench.import_captures import import_session
    from bench.manifest import load_manifest
    from bench.synthetic_audio import SOURCE_SAMPLE_RATE, synthesize_ad, write_wav

    corpus_directory = Path(tempfile.mkdtemp(prefix="corpus_"))
    write_wav(corpus_directory / "reference.wav", synthesize_ad(1, 6.0), SOURCE_SAMPLE_RATE)
    manifest_path = corpus_directory / "manifest.csv"
    manifest_path.write_text("role,path,ad_id,codec,reference_variant\nreference,reference.wav,brand-a,wav,master\n",
                             encoding="utf-8")
    copied_session_directory = corpus_directory / "captures" / session_directory.name
    shutil.copytree(session_directory, copied_session_directory)
    added_count = import_session(copied_session_directory, manifest_path)
    entries = load_manifest(manifest_path)
    report.check(added_count > 0 and len(entries) == added_count + 1,
                 "Session imports into the benchmark corpus and validates", f"{added_count} clips imported")
    import av

    clip_lengths_seconds = []   # (actual, labelled) per imported clip
    for entry in entries:
        if entry.role != "reference" and entry.clip_seconds:
            with av.open(str(entry.path)) as container:
                clip_lengths_seconds.append((float(container.duration or 0) / 1_000_000, entry.clip_seconds))
    report.check(bool(clip_lengths_seconds)
                 and all(labelled - 0.3 <= actual <= labelled + 0.1 for actual, labelled in clip_lengths_seconds),
                 "After import every clip is its labelled length",
                 ", ".join(f"{actual:.2f}/{labelled:g} s" for actual, labelled in clip_lengths_seconds))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--output-directory", type=Path, required=True,
                        help="folder for screenshots and pulled sessions")
    arguments = parser.parse_args()
    output_directory: Path = arguments.output_directory
    output_directory.mkdir(parents=True, exist_ok=True)
    device, report = Device(output_directory), Report()

    device.run_adb("uninstall", APP_PACKAGE_NAME, raise_on_failure=False)
    device.run_adb("install", str(arguments.apk))                     # no -g: the permission prompt must appear
    report.check(True, f"Installed {arguments.apk.name} (release build, no pre-granted permissions)")
    app_title = None
    for _ in range(3):   # a lock screen or a freshly booted launcher can hide the app
        device.wake_screen()
        device.run_adb("shell", "am", "start", "-W", "-n", f"{APP_PACKAGE_NAME}/.MainActivity")
        # inside the app, not its launcher icon
        app_title = device.find_node(r"Look Up Capture", timeout_seconds=10, package_name=APP_PACKAGE_NAME)
        if app_title:
            break
    if not report.check(app_title is not None, "App opens on the capture screen"):
        device.take_screenshot("did-not-open")
        return 1
    device.take_screenshot("home")
    report.check(device.find_node(r"How it works", timeout_seconds=3, package_name=APP_PACKAGE_NAME) is not None,
                 "Explains how to use it on first open")

    # 0. Navigation: the Recordings tab exists, says what to do when empty, and leads back.
    report.check(go_to_tab(device, "Recordings"), "Recordings tab reachable from the bottom bar")
    report.check(device.find_node(r"No recordings yet", timeout_seconds=4) is not None,
                 "Empty Recordings tab explains what to do")
    device.take_screenshot("recordings-empty")
    go_to_record_button = device.find_node(r"^Go to Record$", timeout_seconds=3)
    if go_to_record_button:
        device.tap(go_to_record_button)
    report.check(device.find_node(RECORD_BUTTON_PATTERN, timeout_seconds=4, package_name=APP_PACKAGE_NAME) is not None,
                 "'Go to Record' leads back to the Record tab")

    # 1. Validation: plain-language messages before anything is recorded.
    first_record_button = device.find_node(RECORD_BUTTON_PATTERN, package_name=APP_PACKAGE_NAME)
    if not report.check(first_record_button is not None, "Record button visible on first open"):
        device.take_screenshot("no-record-button")
        return 1
    device.tap(first_record_button)
    report.check(device.find_node(r"phone model first", timeout_seconds=4) is not None,
                 "Refuses to record without a phone model")
    device.take_screenshot("validation")
    text_fields = [node for node in device.read_nodes_on_screen() if node.class_name.endswith("EditText")]
    phone_model_field = (device.find_node(r"Phone model", timeout_seconds=2)
                         or (text_fields[1] if len(text_fields) > 1 else None))
    if not report.check(phone_model_field is not None, "Phone model field found"):
        return 1
    if not report.check(device.type_into(phone_model_field, "emulator-test"), "Phone model typed into its field"):
        device.take_screenshot("typing-failed")
        return 1
    device.tap(device.find_node(RECORD_BUTTON_PATTERN, package_name=APP_PACKAGE_NAME))
    report.check(device.find_node(r"Enter the ad id", timeout_seconds=4) is not None,
                 "Refuses to record without an ad id")
    device.scroll_to_top()
    text_fields = [node for node in device.read_nodes_on_screen() if node.class_name.endswith("EditText")]
    ad_id_field = device.find_node(r"Ad id", timeout_seconds=2) or (text_fields[0] if text_fields else None)
    if not report.check(ad_id_field is not None, "Ad id field found"):
        return 1
    if not report.check(device.type_into(ad_id_field, "brand-a"), "Ad id typed into its field"):
        device.take_screenshot("typing-failed")
        return 1

    expected_clips: list[dict] = []
    set_switch(device, report, r"^Noise suppression", False)
    set_switch(device, report, r"^Auto gain", False)
    set_switch(device, report, r"^Not an ad", False)
    # 2. One 3 s clip with the default mic settings (also exercises the permission prompt).
    select_option(device, r"^3 s$")
    if record_clip(device, report, "3s-default", 3, r"Saved 1 clip", is_first_recording=True):
        expected_clips.append({"clip_seconds": 3, "role": "query", "microphone_settings": "mic/ns-off/agc-off"})
    device.take_screenshot("saved-one")

    # 2b. Listen straight after recording: 'Listen to it' → Recordings tab → Play → it finishes.
    listen_button = device.find_node(r"Listen to it", timeout_seconds=4, scroll_if_not_found=True)
    report.check(listen_button is not None, "'Listen to it' offered right after recording")
    if listen_button:
        device.tap(listen_button)
    report.check(device.find_node(r"Current session · 1 recording\b", timeout_seconds=5) is not None,
                 "Recordings tab shows the new clip in the current session")
    play_button = device.find_node(r"^Play$", timeout_seconds=4)
    if report.check(play_button is not None, "Each clip has a Play button"):
        device.tap(play_button)
        playback_indicator = device.find_node(r"Playing…|^Stop$", timeout_seconds=4)
        report.check(playback_indicator is not None, "Tapping Play plays the clip",
                     playback_indicator.label if playback_indicator else "")
        device.take_screenshot("playing")
        report.check(wait_until_gone(device, r"Playing…", timeout_seconds=10)
                     and device.find_node(r"^Play$", timeout_seconds=3) is not None,
                     "Playback finishes and the button returns to Play")
    report.check(go_to_tab(device, "Record"), "Record tab reachable again from the bottom bar")

    # 3. Cancel half way: the partial clip must be deleted and not listed.
    select_option(device, r"^10 s$")
    record_button = device.find_node(RECORD_BUTTON_PATTERN, package_name=APP_PACKAGE_NAME)
    if not report.check(record_button is not None, "Record button visible before the cancel test"):
        device.take_screenshot("no-record-button-2")
        return 1
    device.tap(record_button)
    time.sleep(2.5)
    device.take_screenshot("recording-before-cancel")
    # Cancel sits at the right end of the bottom bar (16 dp margin, 88 dp wide), level with Record.
    width_pixels, density_dpi = device.read_screen_width_and_density()
    device.run_adb("shell", "input", "tap", str(width_pixels - round(60 * density_dpi / 160)),
                   str(record_button.center_y))
    report.check(device.find_node(r"unfinished clip was deleted", timeout_seconds=8, scroll_if_not_found=True)
                 is not None, "Cancel stops the recording and deletes the unfinished clip")

    # 4. Two takes back to back.
    select_option(device, r"^3 s$")
    select_option(device, r"2 takes in a row")
    if record_clip(device, report, "two-takes", 6, r"Saved 2 clip"):
        expected_clips += [{"clip_seconds": 3, "role": "query", "microphone_settings": "mic/ns-off/agc-off"}] * 2

    # 5. Different mic source + noise suppression, single take.
    select_option(device, r"^1 take$")
    select_option(device, r"voiceRecognition")
    set_switch(device, report, r"^Noise suppression", True)
    if record_clip(device, report, "voicerec-ns", 3, r"Saved 1 clip"):
        expected_clips.append(
            {"clip_seconds": 3, "role": "query", "microphone_settings": "voiceRecognition/ns-on/agc-off"})

    # 6. A negative clip ("not an ad").
    set_switch(device, report, r"^Not an ad", True)
    if record_clip(device, report, "negative", 3, r"Saved 1 clip"):
        expected_clips.append(
            {"clip_seconds": 3, "role": "negative", "microphone_settings": "voiceRecognition/ns-on/agc-off"})
    device.take_screenshot("after-negative")

    # 7. The 'unprocessed' source is missing on some phones: it must fail politely, never crash.
    select_option(device, r"^unprocessed$")
    record_clip(device, report, "unprocessed", 3, r"Saved 1 clip|Recording stopped on this phone")
    is_unprocessed_clip_saved = device.find_node(r"Saved 1 clip", timeout_seconds=1, scroll_if_not_found=True) is not None
    if is_unprocessed_clip_saved:
        expected_clips.append(
            {"clip_seconds": 3, "role": "negative", "microphone_settings": "unprocessed/ns-on/agc-off"})
    report.check(device.find_node(r"Look Up Capture", timeout_seconds=3) is not None,
                 "App still running after the unprocessed-source attempt")

    # 7b. Recordings tab lists everything; delete removes a clip and its label row.
    report.check(go_to_tab(device, "Recordings"), "Back to Recordings")
    saved_clip_count = len(expected_clips)
    report.check(device.find_node(rf"Current session · {saved_clip_count} recordings?\b", timeout_seconds=5) is not None,
                 f"Current session lists all {saved_clip_count} saved clips")
    delete_button = device.find_node(r"^Delete$", timeout_seconds=4)
    if report.check(delete_button is not None, "Each clip has a Delete button"):
        device.tap(delete_button)
        report.check(device.find_node(r"Delete this recording\?", timeout_seconds=4) is not None,
                     "Delete asks for confirmation first")
        device.take_screenshot("delete-confirm")
        confirm_button = device.find_node(r"^Delete$", timeout_seconds=3)
        if confirm_button:
            device.tap(confirm_button)
        if report.check(device.find_node(r"Recording deleted", timeout_seconds=5) is not None,
                        "Clip deleted after confirming"):
            expected_clips.pop()                       # the list is newest first; the newest clip was deleted
        report.check(device.find_node(rf"Current session · {len(expected_clips)} recordings?\b", timeout_seconds=5)
                     is not None, "Count updates after deleting")

    # 8. Send to computer: the share sheet gets the session files.
    device.scroll_to_top()
    share_button = device.find_node(r"^Send to computer$", timeout_seconds=4)
    report.check(share_button is not None, "'Send to computer' button shown once clips exist")
    if share_button:
        device.run_adb("logcat", "-c", raise_on_failure=False)
        device.tap(share_button)
        share_sheet_node = None
        share_request_log_line = ""
        deadline = time.monotonic() + 10
        while share_sheet_node is None and not share_request_log_line and time.monotonic() < deadline:
            share_sheet_node = next((node for node in device.read_nodes_on_screen()
                                     if node.package_name and node.package_name != APP_PACKAGE_NAME), None)
            logcat_output = device.run_adb("logcat", "-d", raise_on_failure=False)
            share_request_log_line = next((line.strip()[:160] for line in logcat_output.splitlines()
                                           if "android.intent.action.CHOOSER" in line
                                           or "android.intent.action.SEND" in line), "")
            time.sleep(0.5)
        # Stripped-down test images have no apps to share to, so the sheet may never draw;
        # what matters is that the app handed Android a share request with the files.
        report.check(share_sheet_node is not None or bool(share_request_log_line),
                     "Share hands the session to Android's share sheet",
                     (share_sheet_node.package_name if share_sheet_node else "") or share_request_log_line)
        device.take_screenshot("share-sheet")
        device.run_adb("shell", "input", "keyevent", "4")
        time.sleep(1)

    # 8b. Close and reopen the app: recordings must still be there.
    device.run_adb("shell", "am", "force-stop", APP_PACKAGE_NAME)
    device.wake_screen()
    device.run_adb("shell", "am", "start", "-W", "-n", f"{APP_PACKAGE_NAME}/.MainActivity")
    device.find_node(r"Look Up Capture", timeout_seconds=10, package_name=APP_PACKAGE_NAME)
    go_to_tab(device, "Recordings")
    report.check(device.find_node(rf"Current session · {len(expected_clips)} recordings?\b", timeout_seconds=6)
                 is not None, "Recordings are still there after closing and reopening the app")

    # 8c. New session: old clips move under 'Earlier sessions', new recordings start fresh.
    new_session_button = device.find_node(r"^Start new session$", timeout_seconds=4, scroll_if_not_found=True)
    if report.check(new_session_button is not None, "'Start new session' button shown"):
        device.tap(new_session_button)
        report.check(device.find_node(r"Start a new session\?", timeout_seconds=4) is not None,
                     "New session explains itself and asks first")
        device.take_screenshot("new-session-confirm")
        confirm_button = device.find_node(r"^Start new session$", timeout_seconds=3)
        if confirm_button:
            device.tap(confirm_button)
        report.check(device.find_node(r"Current session · 0 recordings", timeout_seconds=6) is not None,
                     "New session starts empty")
        report.check(device.find_node(r"Earlier sessions", timeout_seconds=4, scroll_if_not_found=True) is not None
                     and device.find_node(rf"· {len(expected_clips)} recordings?\b", timeout_seconds=4,
                                          scroll_if_not_found=True) is not None,
                     "Earlier session still listed with its clips")
        device.take_screenshot("after-new-session")

    # 9. Pull the sessions off the device and verify every file with the Phase 0 decoder.
    directory_listing = device.run_adb("shell", "ls", SESSIONS_DIRECTORY_ON_DEVICE, raise_on_failure=False).split()
    session_names = sorted(name for name in directory_listing if name.startswith("session_"))
    report.check(len(session_names) == 2, "Two session folders on the device (recorded + new empty one)",
                 " ".join(session_names))
    if session_names:
        device.run_adb("pull", f"{SESSIONS_DIRECTORY_ON_DEVICE}/{session_names[0]}", str(output_directory))
        pulled_session_directory = output_directory / session_names[0]
        verify_session(report, pulled_session_directory, expected_clips)
        import_into_scratch_corpus(report, pulled_session_directory)

    print(f"\n{len(report.results) - report.failed_count} passed, {report.failed_count} failed · "
          f"screenshots in {output_directory}")
    return 1 if report.failed_count else 0


if __name__ == "__main__":
    sys.exit(main())
