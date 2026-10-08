import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/domain/audio_codec.dart';
import 'package:lookup_listener/features/identify/domain/clip_settings.dart';

void main() {
  test('every identify records 8 seconds of AAC at 16 kHz, mono, 24 kbit/s (S4-D6)', () {
    const settings = ClipSettings.standard;
    expect(settings.clipDurationMilliseconds, 8000);
    expect(settings.clipDurationSeconds, 8);
    expect(settings.codec, AudioCodec.aac);
    expect(settings.codec.wireName, 'aac');
    expect(settings.sampleRateHertz, 16000);
    expect(settings.channelCount, 1);
    expect(settings.bitRateBitsPerSecond, 24000);
  });

  test(
    'the settings: 8 seconds at 24 kbit/s is 24,000 bytes of audio, leaving room in 32 KB for the header '
    'and the form (the real clip is measured on the emulator, S4-REQUEST-02)',
    () {
      const settings = ClipSettings.standard;
      final audioBytes = settings.bitRateBitsPerSecond ~/ 8 * settings.clipDurationSeconds;
      expect(audioBytes, 24000);
      // About 1 KB of MP4 header and 1 KB of form overhead still fit (§3.10).
      expect(audioBytes + 2048, lessThanOrEqualTo(32768));
    },
  );

  test('a clip length that is not whole seconds is refused, since the countdown shows seconds', () {
    var clipDurationMilliseconds = 8500;
    expect(
      () => ClipSettings(
        clipDurationMilliseconds: clipDurationMilliseconds,
        codec: AudioCodec.aac,
        sampleRateHertz: 16000,
        channelCount: 1,
        bitRateBitsPerSecond: 24000,
      ),
      throwsA(isA<AssertionError>()),
    );
    clipDurationMilliseconds = 5000;
    expect(
      ClipSettings(
        clipDurationMilliseconds: clipDurationMilliseconds,
        codec: AudioCodec.aac,
        sampleRateHertz: 16000,
        channelCount: 1,
        bitRateBitsPerSecond: 24000,
      ).clipDurationSeconds,
      5,
    );
  });
}
