import 'package:lookup_listener/features/identify/domain/audio_codec.dart';

/// How a clip is recorded and described, in one place (S4-LISTENING-03): the recorder, the
/// Listening countdown, the `clip_duration_milliseconds` field and the Home screen's "about 8
/// seconds" note all read these values, so they can never disagree.
final class ClipSettings {
  const ClipSettings({
    required this.clipDurationMilliseconds,
    required this.codec,
    required this.sampleRateHertz,
    required this.channelCount,
    required this.bitRateBitsPerSecond,
  }) : assert(clipDurationMilliseconds % 1000 == 0, 'The countdown shows whole seconds.');

  /// The settings of every live identify (S4-D6, ADR-001): 8 seconds of AAC-LC, 16 kHz, mono,
  /// 24 kbit/s, which comes to about 26 KB per request, inside the 32 KB limit (S4-REQUEST-02).
  /// 32 kbit/s would pass that limit (S4-D33).
  static const ClipSettings standard = ClipSettings(
    clipDurationMilliseconds: 8000,
    codec: AudioCodec.aac,
    sampleRateHertz: 16000,
    channelCount: 1,
    bitRateBitsPerSecond: 24000,
  );

  /// How long the app records, and the length the request states: the setting, never a
  /// measurement of the file (§3.10).
  final int clipDurationMilliseconds;

  final AudioCodec codec;

  final int sampleRateHertz;

  /// One channel: a radio heard through a phone's microphone gains nothing from stereo.
  final int channelCount;

  final int bitRateBitsPerSecond;

  /// The countdown's starting number, e.g. 8 for "8 seconds left".
  int get clipDurationSeconds => clipDurationMilliseconds ~/ 1000;
}
