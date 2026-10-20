import 'package:dio/dio.dart' show CancelToken;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/listener_install/listener_install_repository.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/core/network/retry_after.dart';
import 'package:lookup_listener/core/time/clock.dart';
import 'package:lookup_listener/features/identify/data/recognize_request_builder.dart';
import 'package:lookup_listener/features/identify/data/recognize_response_parser.dart';
import 'package:lookup_listener/features/identify/domain/captured_clip.dart';
import 'package:lookup_listener/features/identify/domain/recognition_answer.dart';
import 'package:lookup_listener/features/identify/domain/recognition_problem_report.dart';

/// `POST /api/v1/recognize`, one send of a clip at a time (design §3.8 to §3.11), and the crash
/// reports the recognition flow sends.
///
/// - Every send first makes sure the install has a token, registering when it has none or it is
///   due for renewal (T15), and the token goes only in the `Authorization` header.
/// - The body is the request builder's, with `sent_at` taken immediately before this send; the API
///   client gives every send a new `X-Request-Id`, while the clip's idempotency key stays the same.
/// - The answer, or its absence, is read into a [RecognitionAnswer] by the response parser; what
///   it leads to is `SendPolicy`'s decision, which the flow makes. After the API refused the token
///   (401) the flow asks for the next send with `registersAgainFirst`, and the repository then
///   registers again with the same install id before sending (T23).
/// - A registration that fails is read the way a recognize answer is (§3.9): no answer is "no
///   connection", 429 "too many tries", 502 to 504 busy, a 200 the app cannot read a server
///   failure. The answer says it was the registration's, so a crash report names it.
/// - No answer because of the network is [NoAnswer] ("No connection", the clip kept, S4-D12); no
///   answer because the phone itself stopped the request (a fault in the app, plain `http` refused)
///   is [PhoneFaultAnswer], the phone failure with a crash report that names the fault's type only.
/// - Never throws on a network failure; nothing it returns carries exception text or the API's
///   `message`.
class RecognitionRepository {
  /// [clock] is for tests; the app uses the real one. [requestBuilder] and [responseParser] are
  /// the shared ones.
  RecognitionRepository({
    required ApiClient apiClient,
    required ListenerInstallRepository listenerInstallRepository,
    required ClientErrorReporter clientErrorReporter,
    Clock? clock,
    RecognizeRequestBuilder requestBuilder = const RecognizeRequestBuilder(),
    RecognizeResponseParser responseParser = const RecognizeResponseParser(),
  }) : _apiClient = apiClient,
       _listenerInstallRepository = listenerInstallRepository,
       _clientErrorReporter = clientErrorReporter,
       _clock = clock ?? Clock(),
       _requestBuilder = requestBuilder,
       _responseParser = responseParser;

  /// The route, relative to the API's base address; a listener route, so it carries the token.
  static const String path = ListenerRoute.recognize;

  final ApiClient _apiClient;
  final ListenerInstallRepository _listenerInstallRepository;
  final ClientErrorReporter _clientErrorReporter;
  final Clock _clock;
  final RecognizeRequestBuilder _requestBuilder;
  final RecognizeResponseParser _responseParser;

  /// The token the API refused last (401), which the next registration replaces.
  String? _refusedInstallToken;

  /// Sends [clip] once and reads what came back. [cancellation] stops the send when the listener
  /// taps Cancel (T28), which gives [CancelledAnswer]. With [registersAgainFirst] (after a 401) the
  /// install registers again, with the same install id, before the clip is sent. [onSentShare] hears
  /// the share of the request sent so far, from 0 to 1, for the slow Identifying state (P6 design
  /// §2.5).
  Future<RecognitionAnswer> send(
    CapturedClip clip, {
    required RecognitionCancellation cancellation,
    bool registersAgainFirst = false,
    void Function(double sentShare)? onSentShare,
  }) async {
    final registration = await _registration(registersAgainFirst: registersAgainFirst);
    if (cancellation.isCancelled) return const CancelledAnswer();
    switch (registration) {
      case ListenerInstallNotRegistered():
        return _readRegistrationFailure(registration);
      case ListenerInstallRegistered(:final installToken):
        final parts = _requestBuilder.build(clip, sentAt: _clock.now());
        final answer = await _apiClient.postMultipart(
          path,
          fields: parts.textFields,
          file: ApiMultipartFile(
            fieldName: parts.audioPart.fieldName,
            fileName: parts.audioPart.fileName,
            contentType: parts.audioPart.contentType,
            bytes: parts.audioPart.bytes,
          ),
          installToken: installToken,
          cancelToken: cancellation._cancelToken,
          onSendProgress: onSentShare == null
              ? null
              : (sentBytes, totalBytes) {
                  // A total Dio cannot know is -1: no share can be told then.
                  if (totalBytes > 0) onSentShare((sentBytes / totalBytes).clamp(0, 1).toDouble());
                },
        );
        // 401: the API refused this token, which the next registration replaces (T23).
        if (answer case ApiAnswerReceived(status: 401)) _refusedInstallToken = installToken;
        return _readAnswer(answer);
    }
  }

  /// `GET /api/v1/recognitions/{id}` (ADR-005): the result the server held back with `ACCOUNT_REQUIRED`, asked for
  /// once the listener has an account, read exactly as a recognize answer is. After a refused token the install
  /// registers again, once, and asks again. Never throws.
  Future<RecognitionAnswer> reveal(String recognitionId, {bool registersAgainFirst = false}) async {
    final registration = await _registration(registersAgainFirst: registersAgainFirst);
    switch (registration) {
      case ListenerInstallNotRegistered():
        return _readRegistrationFailure(registration);
      case ListenerInstallRegistered(:final installToken):
        final answer = await _apiClient.getJson(ListenerRoute.revealFor(recognitionId), installToken: installToken);
        if (answer case ApiAnswerReceived(status: 401) when !registersAgainFirst) {
          _refusedInstallToken = installToken;
          return reveal(recognitionId, registersAgainFirst: true);
        }
        return _readAnswer(answer);
    }
  }

  /// Sends the crash report `SendPolicy` asked for after an answer the app caused or could not
  /// read (§3.11), from [location] (the route path, e.g. `/identifying`). Resolves to whether the
  /// API accepted it, which decides whether a phone failure may show its code (T39). Never throws.
  Future<ClientErrorReportOutcome> reportAnswerProblem(
    RecognitionProblemReport report, {
    String? location,
  }) => _clientErrorReporter.report(
    kind: ClientErrorKind.reported,
    error: report.summary,
    location: location,
    relatedRequestId: report.relatedRequestId,
    reportRequestId: report.reportRequestId,
  );

  /// Reports a failure on the phone (the recorder, the file, the permission plugin, an unexpected
  /// error in the flow) under [reportRequestId], the id the phone failure's code is made from once
  /// the API accepts it (T14, T39). [description] is the app's own words for what it was doing.
  /// Never throws.
  Future<ClientErrorReportOutcome> reportPhoneFailure({
    required Object error,
    required String description,
    required String reportRequestId,
    StackTrace? stackTrace,
    String? location,
  }) => _clientErrorReporter.report(
    kind: ClientErrorKind.reported,
    error: error,
    stackTrace: stackTrace,
    description: description,
    location: location,
    reportRequestId: reportRequestId,
  );

  Future<ListenerInstallRegistrationResult> _registration({required bool registersAgainFirst}) {
    final refusedInstallToken = _refusedInstallToken;
    if (registersAgainFirst && refusedInstallToken != null) {
      _refusedInstallToken = null;
      return _listenerInstallRepository.registerAgainAfterRefusal(
        refusedToken: refusedInstallToken,
      );
    }
    return _listenerInstallRepository.ensureRegistered();
  }

  /// A failed registration, read as the answer the identify gets (§3.9), marked as the
  /// registration's.
  RecognitionAnswer _readRegistrationFailure(ListenerInstallNotRegistered registration) {
    const answeredRequest = AnsweredRequest.installRegistration;
    final answer = registration.answer;
    final readingProblem = registration.readingProblem;
    if (answer is! ApiAnswerReceived || readingProblem == null) {
      return _readAnswer(answer, answeredRequest: answeredRequest);
    }
    // A 200 that is not a registration the app can read: the API id is taken by the same rule as
    // for any answer (the header, then the body).
    final readAsAnswer = _readAnswer(answer, answeredRequest: answeredRequest);
    return UnreadableAnswer(
      problem: readingProblem,
      apiRequestId: readAsAnswer is ReceivedAnswer ? readAsAnswer.apiRequestId : null,
      answeredRequest: answeredRequest,
    );
  }

  RecognitionAnswer _readAnswer(
    ApiAnswer answer, {
    AnsweredRequest answeredRequest = AnsweredRequest.recognize,
  }) => switch (answer) {
    ApiAnswerNotReceived(reason: ApiNoAnswerReason.cancelled) => const CancelledAnswer(),
    // The network: no network, a timeout, a dropped connection. To the listener all of these are
    // "no connection", and the clip is kept (S4-D12).
    ApiAnswerNotReceived(
      reason: ApiNoAnswerReason.noConnection ||
          ApiNoAnswerReason.timedOut ||
          ApiNoAnswerReason.connectionDropped,
    ) =>
      const NoAnswer(),
    // The phone itself stopped the request: no signal would help, so it is the phone failure, and
    // a developer must hear of it (§3.11).
    ApiAnswerNotReceived(reason: ApiNoAnswerReason.plainHttpRefused) => PhoneFaultAnswer(
      problem: 'the address is plain http outside the development flavour',
      answeredRequest: answeredRequest,
    ),
    ApiAnswerNotReceived(reason: ApiNoAnswerReason.unexpectedFailure, :final faultTypeName) =>
      PhoneFaultAnswer(
        problem: faultTypeName == null
            ? 'a fault in the app'
            : 'a fault in the app ($faultTypeName)',
        answeredRequest: answeredRequest,
      ),
    ApiAnswerReceived(:final status, :final body, :final echoedRequestId, :final retryAfter) =>
      _responseParser.read(
        httpStatus: status,
        body: switch (body) {
          JsonAnswerBody(:final value) => value,
          NotJsonAnswerBody() => null,
        },
        requestIdHeader: echoedRequestId,
        retryAfterSeconds: RetryAfter.parse(retryAfter, now: _clock.now())?.inSeconds,
        answeredRequest: answeredRequest,
      ),
  };
}

/// Stops one send of a clip when the listener taps Cancel on Identifying (T28). Made by the flow
/// for each send, so the presentation layer never handles Dio's own cancel token.
final class RecognitionCancellation {
  final CancelToken _cancelToken = CancelToken();

  bool get isCancelled => _cancelToken.isCancelled;

  /// Stops the send if it is still under way; a later call does nothing.
  void cancel() {
    if (!_cancelToken.isCancelled) _cancelToken.cancel();
  }
}

/// The repository the recognition flow sends with (design §3.5).
///
/// It is made at start-up from the app's one API client, listener install repository, crash
/// reporter and clock, which `lib/core` builds, so `bootstrap()` provides it with
/// `recognitionRepositoryProvider.overrideWith(...)`; tests override it the same way, over a fake
/// HTTP adapter. Reading it without that override is a mistake in the app's set-up, not something a
/// listener can cause.
final Provider<RecognitionRepository> recognitionRepositoryProvider =
    Provider<RecognitionRepository>(
      (ref) => throw UnimplementedError(
        'Override recognitionRepositoryProvider at start-up with the app RecognitionRepository.',
      ),
      // A failing provider is never rebuilt on its own: that could resend a clip (S4-D4).
      retry: (retryCount, error) => null,
    );
