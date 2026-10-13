import 'package:lookup_listener/core/outbox/outbox_item.dart';
import 'package:lookup_listener/core/time/utc_timestamp.dart';
import 'package:lookup_listener/features/identify/domain/captured_clip.dart';

/// Builds the parts of one `POST /recognize` from a clip (§3.10, S4-REQUEST-01 to -06, S4-D8), as
/// plain data the API client turns into Dio's multipart form: the text fields first, in this
/// order, then the audio file part last.
///
/// The contract's own shape (`recognize-request-fields.schema.json`): every field is text,
/// `is_deferred` is `false` for the live flow's sends and `true` for the outbox's ([buildDeferred],
/// contract R2), both built by one method so the two cannot drift; `station_hint` is the clip's
/// hint when it has one and is left out otherwise
/// (P6-MYSTATION-05), and nothing else at all: no install id, token, fingerprint or device detail
/// (S3-ARCHITECTURE-09). The token travels only in the `Authorization` header, which the API client
/// adds; it never passes through here.
final class RecognizeRequestBuilder {
  const RecognizeRequestBuilder();

  /// The file part's field name, file name and type: AAC-LC in MP4, as the API expects.
  static const String audioFieldName = 'audio';
  static const String audioFileName = 'clip.m4a';
  static const String audioContentType = 'audio/mp4';

  /// The parts of one send of [clip]. [sentAt] is the wall-clock time taken immediately before
  /// this send, so a resend after Busy says when it was really sent and the server can correct the
  /// phone's clock from it (S3-D15).
  RecognizeRequestParts build(CapturedClip clip, {required DateTime sentAt}) => _parts(
    clipDurationMilliseconds: clip.clipDurationMilliseconds,
    codec: clip.codec.wireName,
    idempotencyKey: clip.idempotencyKey,
    capturedAt: clip.capturedAt,
    stationHintId: clip.stationHintId,
    audioBytes: clip.audioBytes,
    sentAt: sentAt,
    isDeferred: false,
  );

  /// The parts of one send of a clip the outbox kept (contract R2; P6-OUTBOX-07): `is_deferred`
  /// `"true"`, the stored key, capture time and hint, and [sentAt] taken just before this attempt.
  RecognizeRequestParts buildDeferred(
    DeferredClipItem clip, {
    required List<int> audioBytes,
    required DateTime sentAt,
  }) => _parts(
    clipDurationMilliseconds: clip.clipDurationMilliseconds,
    codec: clip.codec,
    idempotencyKey: clip.idempotencyKey,
    capturedAt: clip.capturedAt,
    stationHintId: clip.stationHintId,
    audioBytes: audioBytes,
    sentAt: sentAt,
    isDeferred: true,
  );

  RecognizeRequestParts _parts({
    required int clipDurationMilliseconds,
    required String codec,
    required String idempotencyKey,
    required DateTime capturedAt,
    required String? stationHintId,
    required List<int> audioBytes,
    required DateTime sentAt,
    required bool isDeferred,
  }) => RecognizeRequestParts(
    textFields: List.unmodifiable([
      MapEntry('clip_duration_milliseconds', '$clipDurationMilliseconds'),
      MapEntry('codec', codec),
      MapEntry('idempotency_key', idempotencyKey.toLowerCase()),
      MapEntry('captured_at', formatUtcTimestamp(capturedAt)),
      MapEntry('sent_at', formatUtcTimestamp(sentAt)),
      MapEntry('is_deferred', isDeferred ? 'true' : 'false'),
      if (stationHintId case final hint? when _isUuid(hint))
        MapEntry('station_hint', hint.toLowerCase()),
    ]),
    audioPart: RecognizeAudioPart(bytes: audioBytes),
  );

  /// A station id the contract accepts as a hint: a UUID of version 1 to 8 (its schema's pattern).
  /// Anything else is left out, so a stored value the server would refuse can never fail every
  /// identify (it ignores an unknown station's hint, but refuses one that is not a UUID).
  static bool _isUuid(String value) => _uuid.hasMatch(value);

  static final RegExp _uuid = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    caseSensitive: false,
  );

  /// [time] as the contract writes it ([UtcTimestamp.format]).
  static String formatUtcTimestamp(DateTime time) => UtcTimestamp.format(time);
}

/// One recognize request's body as plain data, in the shape of Dio's `FormData`: [textFields] in
/// sending order, then [audioPart].
final class RecognizeRequestParts {
  const RecognizeRequestParts({required this.textFields, required this.audioPart});

  /// Name and value of each text field, in the order they are sent.
  final List<MapEntry<String, String>> textFields;

  /// The clip, sent after every text field.
  final RecognizeAudioPart audioPart;
}

/// The multipart file part that carries the clip.
final class RecognizeAudioPart {
  const RecognizeAudioPart({required this.bytes});

  String get fieldName => RecognizeRequestBuilder.audioFieldName;

  String get fileName => RecognizeRequestBuilder.audioFileName;

  String get contentType => RecognizeRequestBuilder.audioContentType;

  /// The recorded bytes, exactly as captured.
  final List<int> bytes;
}
