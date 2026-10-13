import 'dart:convert';
import 'dart:io' show HttpException, SocketException, TlsException;

import 'package:dio/dio.dart';

import '../configuration/app_configuration.dart';
import '../error_reporting/development_log.dart';
import '../identifiers/random_uuid.dart';
import '../time/clock.dart';
import 'api_answer.dart';
import 'api_multipart_file.dart';
import 'listener_route.dart';

export 'api_answer.dart';
export 'api_multipart_file.dart';
export 'listener_route.dart';

/// The app's one way to the Look Up API (design §3.8), on Dio 5.11.1.
///
/// - Paths are relative to `LOOKUP_API_BASE_URL` (`ListenerRoute`: `installs`, `recognize`,
///   `stations`, `recognitions/<id>/choice`, `client-errors`, …).
/// - Plain `http` is refused in Dart unless the flavour is development, and nothing is sent,
///   because Dart's HTTP client cannot be relied on to obey Android's network-security settings
///   (S4-D25). Redirects are not followed, so an `https` request can never be led to `http`.
/// - Every HTTP attempt carries a new version-4 `X-Request-Id`, made before the request so the
///   caller knows it even when no answer comes (S4-D9).
/// - The install token travels only as `Authorization: Bearer`, only to the listener routes, and
///   to `installs` only for a re-registration (`ListenerRoute`; S4-INSTALLS-03, amendment A3).
/// - `getJson` sends a stored entity tag as `If-None-Match`, and a 304 is an ordinary answer with
///   no body (design §3.12; contract §1.4).
/// - Timeouts: connect 15 s, send 30 s (an 8 s clip on slow 2G), receive 15 s (S4-D12).
/// - Dio accepts every status and hands back plain text; the app decodes it, so no status and no
///   body raises an exception. Every method returns an [ApiAnswer] and never throws; no exception
///   text survives into it.
class ApiClient {
  /// [clock], [developmentLog] and [httpClientAdapter] are for tests; the app uses the real clock,
  /// its development log and Dio's own adapter.
  ApiClient({
    required AppConfiguration configuration,
    required RandomUuid randomUuid,
    Clock? clock,
    DevelopmentLog developmentLog = const DevelopmentLog.off(),
    HttpClientAdapter? httpClientAdapter,
    void Function(int bytes)? onBytesUsed,
  }) : _configuration = configuration,
       _onBytesUsed = onBytesUsed,
       _randomUuid = randomUuid,
       _clock = clock ?? Clock(),
       _developmentLog = developmentLog,
       _dio = Dio(
         BaseOptions(
           connectTimeout: connectTimeout,
           sendTimeout: sendTimeout,
           receiveTimeout: receiveTimeout,
           responseType: ResponseType.plain,
           validateStatus: _acceptsEveryStatus,
           receiveDataWhenStatusError: true,
           followRedirects: false,
         ),
       ) {
    if (httpClientAdapter != null) _dio.httpClientAdapter = httpClientAdapter;
  }

  /// How long connecting may take.
  static const Duration connectTimeout = Duration(seconds: 15);

  /// How long sending the request may take: an 8-second clip over slow 2G.
  static const Duration sendTimeout = Duration(seconds: 30);

  /// How long the answer may take once sent; the API waits at most 2.5 s for a worker.
  static const Duration receiveTimeout = Duration(seconds: 15);

  /// The request-id header, sent on every attempt and echoed by the API.
  static const String requestIdHeader = 'X-Request-Id';

  static const String _authorizationHeader = 'Authorization';
  static const String _acceptHeader = 'Accept';
  static const String _ifNoneMatchHeader = 'If-None-Match';

  /// The longest entity tag the app keeps or sends; the API's are a short hash of the body.
  static const int longestEntityTag = 256;

  /// An HTTP entity tag (RFC 9110 §8.8.3), strong or weak, in printable ASCII only: `"abc"` or
  /// `W/"abc"`. Nothing else is sent as `If-None-Match` or kept from an `ETag`, so a header can
  /// never be broken or forged through one.
  static final RegExp _entityTag = RegExp(r'^(?:W/)?"[\x21\x23-\x7E]*"$');

  /// A relative path in lower-case words joined by hyphens and slashes, e.g. `client-errors`:
  /// nothing that could leave the API's base address.
  static final RegExp _relativePath = RegExp(r'^[a-z0-9-]+(/[a-z0-9-]+)*$');

  static final RegExp _versionFourUuid = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  );

  final AppConfiguration _configuration;
  final RandomUuid _randomUuid;
  final Clock _clock;
  final DevelopmentLog _developmentLog;
  final Dio _dio;

  /// Hears the bytes of each request body sent and answer body received, for "Used this month"
  /// (P6 design §3.16): with no answer, only what was sent.
  final void Function(int bytes)? _onBytesUsed;

  /// Sends [body] as JSON to [path].
  ///
  /// [requestId] is for a caller that must know the id before sending (a crash report whose id
  /// becomes a reference code); it must be a fresh lower-case version-4 UUID used for this one
  /// attempt, and anything else is replaced by a new one. The id actually sent is always
  /// [ApiAnswer.sentRequestId].
  Future<ApiAnswer> postJson(
    String path,
    Map<String, Object?> body, {
    String? installToken,
    String? requestId,
    CancelToken? cancelToken,
  }) => _send(
    'POST',
    path,
    buildData: () => body,
    contentType: Headers.jsonContentType,
    installToken: installToken,
    requestId: requestId,
    cancelToken: cancelToken,
  );

  /// Reads [path] with a GET (design §3.12): the station list.
  ///
  /// [ifNoneMatch] is the entity tag of the copy the app holds, from an earlier answer's
  /// [ApiAnswerReceived.entityTag]; the API answers 304 with no body when it still holds. A tag
  /// that is not a well-formed entity tag is not sent, so the API simply answers in full.
  /// [requestId] is used as for [postJson].
  Future<ApiAnswer> getJson(
    String path, {
    String? installToken,
    String? ifNoneMatch,
    String? requestId,
    CancelToken? cancelToken,
  }) => _send(
    'GET',
    path,
    buildData: () => null,
    contentType: null,
    installToken: installToken,
    requestId: requestId,
    cancelToken: cancelToken,
    ifNoneMatch: ifNoneMatch != null && isEntityTag(ifNoneMatch) ? ifNoneMatch : null,
  );

  /// Whether [value] is an entity tag the app may keep and send back.
  static bool isEntityTag(String value) =>
      value.length <= longestEntityTag && _entityTag.hasMatch(value);

  /// Sends a `multipart/form-data` request to [path]: the text [fields] in the order given, then
  /// [file] last.
  Future<ApiAnswer> postMultipart(
    String path, {
    required List<MapEntry<String, String>> fields,
    required ApiMultipartFile file,
    String? installToken,
    String? requestId,
    CancelToken? cancelToken,
    void Function(int sentBytes, int totalBytes)? onSendProgress,
  }) => _send(
    'POST',
    path,
    buildData: () => FormData()
      ..fields.addAll(fields)
      ..files.add(
        MapEntry(
          file.fieldName,
          // In 4 KB pieces, so the progress the upload reports moves as the connection takes them,
          // rather than all at once (P6 design §2.5).
          MultipartFile.fromStream(
            () => Stream.fromIterable(_piecesOf(file.bytes)),
            file.bytes.length,
            filename: file.fileName,
            contentType: DioMediaType.parse(file.contentType),
          ),
        ),
      ),
    // Dio writes the multipart type with its boundary itself.
    contentType: null,
    installToken: installToken,
    requestId: requestId,
    cancelToken: cancelToken,
    onSendProgress: onSendProgress,
  );

  Future<ApiAnswer> _send(
    String method,
    String path, {
    required Object? Function() buildData,
    required String? contentType,
    required String? installToken,
    required String? requestId,
    required CancelToken? cancelToken,
    String? ifNoneMatch,
    void Function(int sentBytes, int totalBytes)? onSendProgress,
  }) async {
    final sentRequestId = requestId != null && _versionFourUuid.hasMatch(requestId)
        ? requestId
        : _randomUuid.generate();
    final startedAt = _clock.monotonicElapsed();
    final answer = await _attempt(
      method,
      path,
      sentRequestId: sentRequestId,
      buildData: buildData,
      contentType: contentType,
      installToken: installToken,
      cancelToken: cancelToken,
      ifNoneMatch: ifNoneMatch,
      onSendProgress: onSendProgress,
    );
    _developmentLog.recordRequest(
      method: method,
      path: _relativePath.hasMatch(path) ? path : '(refused path)',
      requestId: sentRequestId,
      duration: _clock.monotonicElapsed() - startedAt,
      status: switch (answer) {
        ApiAnswerReceived(:final status) => status,
        ApiAnswerNotReceived() => null,
      },
      noAnswerReason: switch (answer) {
        ApiAnswerReceived() => null,
        ApiAnswerNotReceived(:final reason) => reason.name,
      },
      faultTypeName: switch (answer) {
        ApiAnswerReceived() => null,
        ApiAnswerNotReceived(:final faultTypeName) => faultTypeName,
      },
    );
    return answer;
  }

  Future<ApiAnswer> _attempt(
    String method,
    String path, {
    required String sentRequestId,
    required Object? Function() buildData,
    required String? contentType,
    required String? installToken,
    required CancelToken? cancelToken,
    required String? ifNoneMatch,
    void Function(int sentBytes, int totalBytes)? onSendProgress,
  }) async {
    ApiAnswer noAnswer(ApiNoAnswerReason reason, {String? faultTypeName}) => ApiAnswerNotReceived(
      sentRequestId: sentRequestId,
      reason: reason,
      faultTypeName: faultTypeName,
    );
    // What went before the connection failed, if it did.
    var sentBytes = 0;
    try {
      if (!_relativePath.hasMatch(path)) return noAnswer(ApiNoAnswerReason.unexpectedFailure);
      final address = _addressFor(path);
      if (!_maySendTo(address)) return noAnswer(ApiNoAnswerReason.plainHttpRefused);

      final carriesInstallToken = installToken != null && ListenerRoute.mayCarryInstallToken(path);
      final data = buildData();
      final requestBytes = _bodyBytesOf(data);
      // `String`, not `Object?`: for any other type Dio switches itself to decoding JSON, and a
      // broken JSON body would then fail as if no answer had come.
      final response = await _dio.requestUri<String>(
        address,
        data: data,
        cancelToken: cancelToken,
        onSendProgress: (sent, total) {
          sentBytes = sent;
          onSendProgress?.call(sent, total);
        },
        options: Options(
          method: method,
          contentType: contentType,
          headers: {
            requestIdHeader: sentRequestId,
            _acceptHeader: Headers.jsonContentType,
            if (carriesInstallToken) _authorizationHeader: 'Bearer $installToken',
            _ifNoneMatchHeader: ?ifNoneMatch,
          },
        ),
      );
      final status = response.statusCode;
      final text = response.data;
      _countBytes(requestBytes + utf8.encode(text ?? '').length);
      if (status == null) return noAnswer(ApiNoAnswerReason.unexpectedFailure);
      final entityTag = _singleHeaderValue(response.headers, 'etag');
      return ApiAnswerReceived(
        sentRequestId: sentRequestId,
        status: status,
        echoedRequestId: _singleHeaderValue(response.headers, 'x-request-id'),
        retryAfter: _singleHeaderValue(response.headers, 'retry-after'),
        entityTag: entityTag != null && isEntityTag(entityTag) ? entityTag : null,
        body: ApiAnswerBody.fromText(text ?? ''),
      );
    } on DioException catch (exception) {
      _countBytes(sentBytes);
      final reason = _reasonFor(exception);
      return noAnswer(
        reason,
        faultTypeName: reason == ApiNoAnswerReason.unexpectedFailure
            ? _faultTypeNameOf(exception)
            : null,
      );
    } on Object catch (error) {
      // Building the request failed on the phone (a malformed media type, a header Dart refuses):
      // a fault in the app. Only its type is kept, never its text, so nothing technical can reach
      // the screen and the crash report says only what kind of fault it was.
      return noAnswer(
        ApiNoAnswerReason.unexpectedFailure,
        faultTypeName: error.runtimeType.toString(),
      );
    }
  }

  /// [path] under the configured base address, which ends `/api/v1` with no slash.
  Uri _addressFor(String path) {
    final baseAddress = _configuration.apiBaseUrl;
    final basePath = baseAddress.path.endsWith('/')
        ? baseAddress.path.substring(0, baseAddress.path.length - 1)
        : baseAddress.path;
    return baseAddress.replace(path: '$basePath/$path');
  }

  /// `https` always; plain `http` only in the development flavour; nothing else ever.
  bool _maySendTo(Uri address) {
    if (address.host.isEmpty) return false;
    if (address.scheme == 'https') return true;
    return address.scheme == 'http' && _configuration.flavour == AppFlavour.development;
  }

  static bool _acceptsEveryStatus(int? status) => true;

  /// The size of a request's body as sent: a form's whole length, a JSON body's encoded bytes.
  static int _bodyBytesOf(Object? data) => switch (data) {
    FormData() => data.length,
    Map<String, Object?>() => utf8.encode(jsonEncode(data)).length,
    _ => 0,
  };

  void _countBytes(int bytes) {
    final onBytesUsed = _onBytesUsed;
    if (onBytesUsed == null || bytes <= 0) return;
    try {
      onBytesUsed(bytes);
    } on Object {
      // Counting never fails a request.
    }
  }

  /// How large each piece of an uploaded file is.
  static const int uploadPieceBytes = 4096;

  static Iterable<List<int>> _piecesOf(List<int> bytes) sync* {
    for (var start = 0; start < bytes.length; start += uploadPieceBytes) {
      final end = start + uploadPieceBytes < bytes.length ? start + uploadPieceBytes : bytes.length;
      yield bytes.sublist(start, end);
    }
  }

  /// A header's value when it came exactly once; a repeated header is not trusted.
  static String? _singleHeaderValue(Headers headers, String lowerCaseName) {
    final values = headers.map[lowerCaseName];
    return values != null && values.length == 1 ? values.single : null;
  }

  /// The type behind a fault Dio wrapped (e.g. `StateError`), or Dio's own kind of failure when it
  /// wrapped nothing; never the text of either.
  static String _faultTypeNameOf(DioException exception) =>
      exception.error?.runtimeType.toString() ?? 'DioException (${exception.type.name})';

  static ApiNoAnswerReason _reasonFor(DioException exception) => switch (exception.type) {
    DioExceptionType.connectionTimeout ||
    DioExceptionType.sendTimeout ||
    DioExceptionType.receiveTimeout ||
    DioExceptionType.transformTimeout => ApiNoAnswerReason.timedOut,
    DioExceptionType.cancel => ApiNoAnswerReason.cancelled,
    DioExceptionType.connectionError ||
    DioExceptionType.badCertificate => ApiNoAnswerReason.noConnection,
    // Cannot happen while every status is accepted; if it did, no usable answer was read.
    DioExceptionType.badResponse => ApiNoAnswerReason.unexpectedFailure,
    DioExceptionType.unknown => switch (exception.error) {
      SocketException() || TlsException() => ApiNoAnswerReason.noConnection,
      HttpException() => ApiNoAnswerReason.connectionDropped,
      _ => ApiNoAnswerReason.unexpectedFailure,
    },
  };
}
