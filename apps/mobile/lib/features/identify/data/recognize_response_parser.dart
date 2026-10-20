import 'dart:convert';

import 'package:lookup_listener/features/identify/domain/recognition_answer.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/result/domain/action_card_reader.dart';
import 'package:lookup_listener/features/result/domain/recognition_result.dart';

/// Reads the API's answer to one `POST /recognize` into a [RecognitionAnswer] (S4-D15, §3.8).
///
/// Tolerant where tolerance keeps an older app working against a newer server, strict where the
/// screen needs something: required are `status` and, for `MATCH`, the recognition id (a lower-case
/// UUID version 7, which the choice, History and taps name) and a readable result (station id, name
/// and frequency, client name, title, and a card, read by the shared card reader). A
/// `CHOOSE_STATION` needs the recognition id and 2 to 4 readable candidates, each a different
/// station, and never a `result` beside them (P6 design §2.17, T19′ and T19″); a candidate is read
/// as a result is. The station's city is read when it is text and left out otherwise; the answer's
/// `captured_at` is kept when it is a time. Unknown fields are never read, so nothing internal can
/// reach the screen; images are kept only from https; an unknown result kind reads as a campaign
/// and an unknown status as "newer app needed".
/// Error envelopes give their code, request id and refused fields; the `message` is never read, so
/// the app can only ever show its own words (S4-D13). Never throws.
final class RecognizeResponseParser {
  const RecognizeResponseParser();

  /// [body] is the decoded JSON, or null when the body was empty or not JSON. [requestIdHeader] is
  /// the answer's `X-Request-Id` header and [retryAfterSeconds] its `Retry-After` in whole seconds
  /// as read (null when missing or unreadable), both taken from the headers by the caller.
  /// [answeredRequest] says whose answer it is when a refused install registration is read the way
  /// a recognize answer is (§3.9), so a crash report names the registration.
  RecognitionAnswer read({
    required int httpStatus,
    required Object? body,
    String? requestIdHeader,
    int? retryAfterSeconds,
    AnsweredRequest answeredRequest = AnsweredRequest.recognize,
  }) {
    final apiRequestId = _apiRequestIdFrom(requestIdHeader, body);
    if (httpStatus != 200) {
      return _readErrorStatus(httpStatus, body, apiRequestId, retryAfterSeconds, answeredRequest);
    }
    UnreadableAnswer unreadable(String problem) => UnreadableAnswer(
      problem: problem,
      apiRequestId: apiRequestId,
      answeredRequest: answeredRequest,
    );
    if (body is! Map<Object?, Object?>) return unreadable('the body is not a JSON object');
    final recognitionId = _readRecognitionId(body['recognition_id']);
    final capturedAt = _readTime(body['captured_at']);
    return switch (body['status']) {
      'MATCH' => _readMatch(body, recognitionId, capturedAt, apiRequestId, unreadable),
      'NO_MATCH' => NoMatchAnswer(
        apiRequestId: apiRequestId,
        recognitionId: recognitionId,
        capturedAt: capturedAt,
      ),
      'CHOOSE_STATION' => _readChooser(body, recognitionId, capturedAt, apiRequestId, unreadable),
      'ACCOUNT_REQUIRED' =>
        recognitionId == null
            ? unreadable(_unreadableRecognitionIdProblem('ACCOUNT_REQUIRED'))
            : AccountRequiredAnswer(
                recognitionId: recognitionId,
                answerBody: _answerBodyOf(body),
                apiRequestId: apiRequestId,
                capturedAt: capturedAt,
              ),
      String() => UnknownStatusAnswer(apiRequestId: apiRequestId),
      _ => unreadable('status is missing or not text'),
    };
  }

  /// As [read], from the body's text as the API client receives it (plain text, so a body that is
  /// not JSON is an answer to read, never an exception carrying technical text).
  RecognitionAnswer readText({
    required int httpStatus,
    required String bodyText,
    String? requestIdHeader,
    int? retryAfterSeconds,
  }) {
    Object? body;
    try {
      body = jsonDecode(bodyText);
    } on FormatException {
      body = null;
    }
    return read(
      httpStatus: httpStatus,
      body: body,
      requestIdHeader: requestIdHeader,
      retryAfterSeconds: retryAfterSeconds,
    );
  }

  /// A `MATCH` the screen cannot show: which fields it needs.
  static const String _unreadableMatchProblem =
      'MATCH without a readable result (needs station id, name and frequency_label, '
      'client name, title and card)';

  /// An answer of [status] whose recognition id is missing or not a lower-case UUID version 7.
  static String _unreadableRecognitionIdProblem(String status) =>
      '$status without a recognition_id that is a lower-case UUID version 7';

  /// The match, or the unreadable answer when it is not one the screen can show.
  RecognitionAnswer _readMatch(
    Map<Object?, Object?> body,
    String? recognitionId,
    DateTime? capturedAt,
    String? apiRequestId,
    UnreadableAnswer Function(String problem) unreadable,
  ) {
    if (recognitionId == null) return unreadable(_unreadableRecognitionIdProblem('MATCH'));
    final readResult = _readResult(body['result'], recognitionId);
    if (readResult == null) return unreadable(_unreadableMatchProblem);
    return MatchAnswer(
      result: readResult,
      answerBody: _answerBodyOf(body),
      apiRequestId: apiRequestId,
      capturedAt: capturedAt,
    );
  }

  /// The chooser of T19′, or the unreadable answer of T19″: the sheet needs the recognition id the
  /// choice is sent for, and 2 to 4 readable candidates, each a different station; a `result`
  /// beside the candidates contradicts them.
  RecognitionAnswer _readChooser(
    Map<Object?, Object?> body,
    String? recognitionId,
    DateTime? capturedAt,
    String? apiRequestId,
    UnreadableAnswer Function(String problem) unreadable,
  ) {
    if (body.containsKey('result')) {
      return unreadable('CHOOSE_STATION with a result beside its candidates');
    }
    if (recognitionId == null) {
      return unreadable(_unreadableRecognitionIdProblem('CHOOSE_STATION'));
    }
    final entries = body['candidates'];
    if (entries is! List<Object?> ||
        entries.length < ChooseStationState.minimumCandidates ||
        entries.length > ChooseStationState.maximumCandidates) {
      return unreadable('CHOOSE_STATION without a list of 2 to 4 candidates');
    }
    final candidates = [for (final entry in entries) ?_readResult(entry, recognitionId)];
    if (candidates.length < ChooseStationState.minimumCandidates) {
      return unreadable(
        'CHOOSE_STATION with fewer than 2 readable candidates (each needs station id, name and '
        'frequency_label, client name, title and card)',
      );
    }
    final stationIds = {for (final candidate in candidates) candidate.stationId};
    if (stationIds.length != candidates.length) {
      return unreadable('CHOOSE_STATION offering one station twice');
    }
    return ChooseStationAnswer(
      recognitionId: recognitionId,
      candidates: candidates,
      answerBody: _answerBodyOf(body),
      apiRequestId: apiRequestId,
      capturedAt: capturedAt,
    );
  }

  /// [body] as History keeps it: the answer exactly as it came, its keys as text, as JSON has them.
  static Map<String, Object?> _answerBodyOf(Map<Object?, Object?> body) => Map.unmodifiable({
    for (final MapEntry(:key, :value) in body.entries)
      if (key is String) key: value,
  });

  /// The result of a match, or one candidate of a chooser, for [recognitionId]; null when [result]
  /// is not one the screen can show.
  RecognitionResult? _readResult(Object? result, String recognitionId) {
    if (result case {
      'station':
          {
            'id': final String stationId,
            'name': final String stationName,
            'frequency_label': final String stationFrequencyLabel,
          } &&
          final Map<Object?, Object?> station,
      'client': {'name': final String clientName} && final Map<Object?, Object?> client,
      'title': final String title,
      'card': final Map<Object?, Object?> card,
    } when [stationId, stationName, stationFrequencyLabel, clientName, title].every(_isNonBlank)) {
      final city = station['city'];
      return RecognitionResult(
        recognitionId: recognitionId,
        kind: result['kind'] == 'CLIENT_DEFAULT'
            ? RecognitionResultKind.clientDefault
            : RecognitionResultKind.campaign,
        stationId: stationId,
        stationName: stationName,
        stationFrequencyLabel: stationFrequencyLabel,
        stationCity: city is String && _isNonBlank(city) ? city : null,
        clientName: clientName,
        title: title,
        card: readActionCard(card),
        stationLogo: _readImage(station['logo']),
        clientLogo: _readImage(client['logo']),
        headerImage: _readImage(card['header_image']),
      );
    }
    return null;
  }

  /// [value] when it is a lower-case UUID version 7, the contract's recognition id; else null.
  static String? _readRecognitionId(Object? value) =>
      value is String && _recognitionId.hasMatch(value) ? value : null;

  /// [value] as a time in UTC when it is ISO 8601 with a time zone; else null.
  static DateTime? _readTime(Object? value) {
    if (value is! String || !_timeWithZone.hasMatch(value)) return null;
    return DateTime.tryParse(value)?.toUtc();
  }

  /// An image the phone may download, or null: only https addresses of the contract's shape, with
  /// the sizes the screen relies on. A bad image never makes the result unreadable; the card is
  /// shown without it.
  static PublicImage? _readImage(Object? image) {
    if (image
        case {
          'address': final String address,
          'width_pixels': final int widthPixels,
          'height_pixels': final int heightPixels,
          'size_bytes': final int sizeBytes,
        }
        when _isHttpsAddress(address) &&
            _isImageSide(widthPixels) &&
            _isImageSide(heightPixels) &&
            sizeBytes >= 1) {
      return PublicImage(
        address: address,
        widthPixels: widthPixels,
        heightPixels: heightPixels,
        sizeBytes: sizeBytes,
      );
    }
    return null;
  }

  static ErrorStatusAnswer _readErrorStatus(
    int httpStatus,
    Object? body,
    String? apiRequestId,
    int? retryAfterSeconds,
    AnsweredRequest answeredRequest,
  ) {
    final envelope = body is Map<Object?, Object?> ? body['error'] : null;
    if (envelope is! Map<Object?, Object?>) {
      return ErrorStatusAnswer(
        httpStatus: httpStatus,
        apiRequestId: apiRequestId,
        retryAfterSeconds: retryAfterSeconds,
        answeredRequest: answeredRequest,
      );
    }
    final errorCode = envelope['code'];
    final fields = envelope['fields'];
    return ErrorStatusAnswer(
      httpStatus: httpStatus,
      apiRequestId: apiRequestId,
      errorCode: errorCode is String && _errorCode.hasMatch(errorCode) ? errorCode : null,
      retryAfterSeconds: retryAfterSeconds,
      fieldProblems: List.unmodifiable([
        for (final field in fields is List<Object?> ? fields.take(_largestFieldCount) : const [])
          if (field case {
            'path': final String path,
            'code': final String code,
          } when _fieldPath.hasMatch(path) && _fieldCode.hasMatch(code))
            FieldProblem(path: path, code: code),
      ]),
      answeredRequest: answeredRequest,
    );
  }

  /// The `X-Request-Id` header when it is a UUID, else the body's request id (the error
  /// envelope's, or the recognize answer's) when that is one; lower case, as the API logs it.
  static String? _apiRequestIdFrom(String? requestIdHeader, Object? body) {
    final envelope = body is Map<Object?, Object?> ? body['error'] : null;
    final candidates = [
      requestIdHeader,
      if (envelope is Map<Object?, Object?>) envelope['request_id'],
      if (body is Map<Object?, Object?>) body['request_id'],
    ];
    for (final candidate in candidates) {
      if (candidate is String && _requestIdUuid.hasMatch(candidate)) {
        return candidate.toLowerCase();
      }
    }
    return null;
  }

  static bool _isNonBlank(String text) => text.trim().isNotEmpty;

  static bool _isHttpsAddress(String address) =>
      address.length <= _longestImageAddress &&
      _httpsAddress.hasMatch(address) &&
      (Uri.tryParse(address)?.host.isNotEmpty ?? false);

  static bool _isImageSide(int pixels) => pixels >= 1 && pixels <= _largestImageSidePixels;

  /// The API's own request-id rule (`assign-request-id.ts`): a UUID of version 1 to 8.
  static final RegExp _requestIdUuid = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    caseSensitive: false,
  );

  /// The contract's `RecognitionId`: a lower-case UUID version 7.
  static final RegExp _recognitionId = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  );

  /// An ISO 8601 time with seconds and a time zone (`Z` or an offset), as the API writes them.
  static final RegExp _timeWithZone = RegExp(
    r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$',
  );

  /// The contract's patterns for an error code, a refused field's code and an image address.
  static final RegExp _errorCode = RegExp(r'^[A-Z][A-Z0-9_]{1,63}$');
  static final RegExp _fieldCode = RegExp(r'^[a-z][a-z0-9_]{0,63}$');
  static final RegExp _httpsAddress = RegExp(r'^https://[^\s/?#]+[^\s]*$');

  /// A field path as the API writes one (`captured_at`, `card.actions[0].label`); anything else is
  /// left out, so nothing odd reaches a crash report.
  static final RegExp _fieldPath = RegExp(r'^[A-Za-z0-9_.\[\]]{1,120}$');

  static const int _longestImageAddress = 2048;
  static const int _largestImageSidePixels = 4096;

  /// The envelope never lists more (its schema's `maxItems`).
  static const int _largestFieldCount = 20;
}
