import 'package:lookup_listener/features/identify/domain/audio_codec.dart';
import 'package:lookup_listener/features/identify/domain/clip_settings.dart';

/// One recorded clip, in memory, with what every send of it repeats (S4-D7, S4-D8).
///
/// Held privately by the recognition flow, never inside a state, and dropped on every outcome and
/// way out, so "We don't keep the recording" stays true. The idempotency key and capture time are
/// made once, when recording starts, so every resend of this clip (after Busy, a 409, a 401 or
/// "Send again") is the same clip to the server and is answered as a replay if it already has it.
final class CapturedClip {
  /// [settings] are the ones the recorder used: the length and codec sent are the settings, never
  /// measured from the file (§3.10).
  CapturedClip({
    required List<int> audioBytes,
    required this.idempotencyKey,
    required DateTime capturedAt,
    required ClipSettings settings,
  }) : audioBytes = List<int>.unmodifiable(audioBytes),
       capturedAt = capturedAt.toUtc(),
       clipDurationMilliseconds = settings.clipDurationMilliseconds,
       codec = settings.codec;

  /// The recorded file's bytes (AAC-LC in MP4). A copy that cannot be changed, so a resend always
  /// carries exactly what was recorded.
  final List<int> audioBytes;

  /// A lower-case version-4 UUID, made when recording started; the same on every send of this clip.
  final String idempotencyKey;

  /// The phone's wall-clock time when recording started, in UTC. The server corrects it with the
  /// request's `sent_at` (S3-D15), so a wrong phone clock does no harm.
  final DateTime capturedAt;

  final int clipDurationMilliseconds;

  final AudioCodec codec;
}
