import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

/// One request the fake received: its options as Dio passed them, and the body bytes exactly as
/// they would have gone on the wire.
final class FakeHttpRequest {
  FakeHttpRequest(this.options, this.bodyBytes);

  final RequestOptions options;

  final Uint8List bodyBytes;

  Uri get address => options.uri;

  String get method => options.method;

  /// A request header by name, in any case; null when the request did not carry it.
  String? header(String name) {
    for (final MapEntry(:key, :value) in options.headers.entries) {
      if (key.toLowerCase() == name.toLowerCase()) return value?.toString();
    }
    return null;
  }

  /// Whether the request carried [name] at all, in any case.
  bool hasHeader(String name) => header(name) != null;

  String get bodyText => utf8.decode(bodyBytes);

  /// The body decoded as JSON.
  Object? get jsonBody => jsonDecode(bodyText);
}

/// How the fake answers one request: an answer, or an exception thrown as a real adapter would.
typedef FakeHttpAnswer =
    Future<ResponseBody> Function(FakeHttpRequest request, Future<void>? cancelFuture);

/// Dio's transport replaced for tests (design §4.1): it answers from a script, one entry per
/// request in order, records every request, and never touches the network.
class FakeHttpClientAdapter implements HttpClientAdapter {
  final List<FakeHttpAnswer> _script = [];

  /// Every request received, in order.
  final List<FakeHttpRequest> requests = [];

  /// Answers the next request with [status] and [body] as JSON.
  void answerJson(int status, Object? body, {Map<String, List<String>> headers = const {}}) =>
      answerText(
        status,
        jsonEncode(body),
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
          ...headers,
        },
      );

  /// Answers the next request with [status] and [text] as the body.
  void answerText(int status, String text, {Map<String, List<String>> headers = const {}}) =>
      answerWith(
        (request, cancelFuture) async =>
            ResponseBody.fromString(text, status, headers: {...headers}),
      );

  /// Answers the next request with [status] and these raw [bytes] as the body.
  void answerBytes(int status, List<int> bytes, {Map<String, List<String>> headers = const {}}) =>
      answerWith(
        (request, cancelFuture) async =>
            ResponseBody.fromBytes(bytes, status, headers: {...headers}),
      );

  /// Makes the next request fail with [error], thrown from the transport as a real one would.
  void failWith(Object error) => answerWith((request, cancelFuture) async => throw error);

  /// Makes the next request fail with a Dio exception of [type] (a timeout, a connection error).
  void failWithDioType(DioExceptionType type) => answerWith(
    (request, cancelFuture) async =>
        throw DioException(requestOptions: request.options, type: type, message: 'fake $type'),
  );

  /// Holds the next request without answering until it is cancelled.
  void waitUntilCancelled() => answerWith((request, cancelFuture) async {
    await (cancelFuture ?? Completer<void>().future);
    throw DioException.requestCancelled(requestOptions: request.options, reason: 'cancelled');
  });

  /// Answers the next request with [answer].
  void answerWith(FakeHttpAnswer answer) => _script.add(answer);

  /// The next request's body is read only up to [bytes], then the rest once [resume] completes,
  /// as a slow connection takes it: the upload's progress stops part way until then.
  void holdNextBodyAfter(int bytes, Future<void> resume) => _nextBodyHold = (bytes, resume);

  (int, Future<void>)? _nextBodyHold;

  /// How many scripted answers are still waiting for a request.
  int get unusedAnswerCount => _script.length;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final bodyBytes = <int>[];
    final hold = _nextBodyHold;
    _nextBodyHold = null;
    if (requestStream != null) {
      var isHeld = hold != null;
      await for (final chunk in requestStream) {
        bodyBytes.addAll(chunk);
        if (isHeld && bodyBytes.length >= hold!.$1) {
          isHeld = false;
          await hold.$2;
        }
      }
    }
    final request = FakeHttpRequest(options, Uint8List.fromList(bodyBytes));
    requests.add(request);
    if (_script.isEmpty) {
      throw StateError('The test scripted no answer for request ${requests.length}.');
    }
    return _script.removeAt(0)(request, cancelFuture);
  }

  @override
  void close({bool force = false}) {}
}
