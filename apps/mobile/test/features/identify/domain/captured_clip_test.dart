import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/domain/audio_codec.dart';
import 'package:lookup_listener/features/identify/domain/captured_clip.dart';
import 'package:lookup_listener/features/identify/domain/clip_settings.dart';

void main() {
  test('the length and codec come from the settings, never from the file', () {
    final clip = CapturedClip(
      audioBytes: const [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70],
      idempotencyKey: '3b9e7c1a-5d2f-4e8b-9a6c-1f0d2e3c4b5a',
      capturedAt: DateTime.utc(2026, 10, 8, 9, 15, 2, 123),
      settings: ClipSettings.standard,
    );
    expect(clip.clipDurationMilliseconds, 8000);
    expect(clip.codec, AudioCodec.aac);
    expect(clip.idempotencyKey, '3b9e7c1a-5d2f-4e8b-9a6c-1f0d2e3c4b5a');
  });

  test('the bytes are a copy that cannot change, so every resend carries what was recorded', () {
    final recordedBytes = [1, 2, 3];
    final clip = CapturedClip(
      audioBytes: recordedBytes,
      idempotencyKey: '3b9e7c1a-5d2f-4e8b-9a6c-1f0d2e3c4b5a',
      capturedAt: DateTime.utc(2026, 10, 8),
      settings: ClipSettings.standard,
    );
    recordedBytes[0] = 99;
    expect(clip.audioBytes, [1, 2, 3]);
    expect(() => clip.audioBytes[0] = 7, throwsUnsupportedError);
  });

  test('the capture time is kept in UTC, the same moment however it was given', () {
    final localTime = DateTime(2026, 10, 8, 11, 15, 2, 123);
    final clip = CapturedClip(
      audioBytes: const [1],
      idempotencyKey: '3b9e7c1a-5d2f-4e8b-9a6c-1f0d2e3c4b5a',
      capturedAt: localTime,
      settings: ClipSettings.standard,
    );
    expect(clip.capturedAt.isUtc, isTrue);
    expect(clip.capturedAt, localTime.toUtc());
  });
}
