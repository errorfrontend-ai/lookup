/// Why an identify ended on the Error screen: one value per variant of §2.10.
///
/// Sealed, so the Error screen's wording, icon and buttons are an exhaustive switch with no
/// default branch: a seventh failure cannot compile without its screen (S4-STATE-09). Every field
/// is non-null (S4-STATE-07); none of them is text for the listener, because the app writes its
/// own words for each variant and never shows the API's `message` (S4-D13).
sealed class RecognitionFailure {
  const RecognitionFailure();

  /// The request id the reference code is made from, or null when no code may be shown (S4-D9,
  /// S4-ERRORHANDLING-03): only an id the API echoed, which it logged, or the id of a crash report
  /// the API accepted. So "share this code with support" is only said when support can find it.
  String? get referenceCodeRequestId => switch (this) {
    ServerFailure(:final requestId) => requestId,
    RecordingUnusableFailure(:final requestId) => requestId,
    PhoneFailure(:final reportRequestId, reportDelivery: ReportDelivery.accepted) =>
      reportRequestId,
    PhoneFailure() => null,
    ConnectionFailure() => null,
    TooManyTriesFailure() => null,
    NewerAppNeededFailure() => null,
  };
}

/// Something went wrong on the API's side, or the app sent something the API refused: "Something
/// went wrong on our side", with the reference code.
final class ServerFailure extends RecognitionFailure {
  const ServerFailure({required this.requestId});

  /// The API's id for the answer (a UUID it logged), from which the reference code is made.
  final String requestId;

  @override
  bool operator ==(Object other) => other is ServerFailure && other.requestId == requestId;

  @override
  int get hashCode => Object.hash(ServerFailure, requestId);

  @override
  String toString() => 'ServerFailure(requestId: $requestId)';
}

/// Something failed on the phone (the recorder, the file, an unexpected error in the flow), or an
/// answer the server should have logged arrived with no request id. The app reports it; the code
/// appears only once the API has accepted the report (T39).
final class PhoneFailure extends RecognitionFailure {
  const PhoneFailure({required this.reportRequestId, required this.reportDelivery});

  /// The crash report's own `X-Request-Id`, made by the app before the report is sent.
  final String reportRequestId;

  final ReportDelivery reportDelivery;

  @override
  bool operator ==(Object other) =>
      other is PhoneFailure &&
      other.reportRequestId == reportRequestId &&
      other.reportDelivery == reportDelivery;

  @override
  int get hashCode => Object.hash(PhoneFailure, reportRequestId, reportDelivery);

  @override
  String toString() =>
      'PhoneFailure(reportRequestId: $reportRequestId, reportDelivery: ${reportDelivery.name})';
}

/// Where the crash report behind a [PhoneFailure] stands.
enum ReportDelivery {
  /// Sent, not yet answered: no code yet.
  sending,

  /// The API answered 202, so it logged the report under its id: the code may be shown.
  accepted,

  /// Refused or never answered: no code, because support could not find it.
  notAccepted,
}

/// The API could not use the recording (400 `INVALID_AUDIO`): "We couldn't use that recording".
final class RecordingUnusableFailure extends RecognitionFailure {
  const RecordingUnusableFailure({required this.requestId});

  /// The API's id for the answer, from which the reference code is made.
  final String requestId;

  @override
  bool operator ==(Object other) =>
      other is RecordingUnusableFailure && other.requestId == requestId;

  @override
  int get hashCode => Object.hash(RecordingUnusableFailure, requestId);

  @override
  String toString() => 'RecordingUnusableFailure(requestId: $requestId)';
}

/// No answer came back (no network, a timeout, a dropped connection): "No connection". The clip is
/// kept, so "Send again" resends it with the same idempotency key.
final class ConnectionFailure extends RecognitionFailure {
  const ConnectionFailure();

  @override
  bool operator ==(Object other) => other is ConnectionFailure;

  @override
  int get hashCode => (ConnectionFailure).hashCode;

  @override
  String toString() => 'ConnectionFailure()';
}

/// The API refused for too many identifies (429): "Too many tries".
final class TooManyTriesFailure extends RecognitionFailure {
  const TooManyTriesFailure({required this.isShortWait});

  /// Whether the API asked for a wait of a minute or less, so "Please wait a minute" is true;
  /// otherwise the screen says "Please try again later."
  final bool isShortWait;

  @override
  bool operator ==(Object other) =>
      other is TooManyTriesFailure && other.isShortWait == isShortWait;

  @override
  int get hashCode => Object.hash(TooManyTriesFailure, isShortWait);

  @override
  String toString() => 'TooManyTriesFailure(isShortWait: $isShortWait)';
}

/// The answer is one this version of the app cannot show (a status it does not know, or 426):
/// "This needs a newer Look Up". `CHOOSE_STATION` is the chooser since Phase 6, so this failure no
/// longer has a several-stations wording (P6 design §2.15).
final class NewerAppNeededFailure extends RecognitionFailure {
  const NewerAppNeededFailure();

  @override
  bool operator ==(Object other) => other is NewerAppNeededFailure;

  @override
  int get hashCode => (NewerAppNeededFailure).hashCode;

  @override
  String toString() => 'NewerAppNeededFailure()';
}
