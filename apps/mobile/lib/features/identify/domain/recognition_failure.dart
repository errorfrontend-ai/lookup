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
    AppUpdateRequiredFailure() => null,
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

/// This version of the app is too old for Look Up (426 `APP_UPDATE_REQUIRED`, T26′): "Please update
/// the app" (P6 design §2.15; P6-COMPATIBILITY-02). The clip is dropped; there is no store button
/// until a listing exists (Q14).
final class AppUpdateRequiredFailure extends RecognitionFailure {
  const AppUpdateRequiredFailure();

  @override
  bool operator ==(Object other) => other is AppUpdateRequiredFailure;

  @override
  int get hashCode => (AppUpdateRequiredFailure).hashCode;

  @override
  String toString() => 'AppUpdateRequiredFailure()';
}

/// The answer is one this version of the app cannot show (a status it does not know): "This needs
/// a newer Look Up". `CHOOSE_STATION` is the chooser since Phase 6, so this failure no longer has a
/// several-stations wording, and a 426 is "Please update the app" (P6 design §2.15). "No
/// connection" and "Too many tries" are retired: their clips go to Saved offline (T24′, T27′).
final class NewerAppNeededFailure extends RecognitionFailure {
  const NewerAppNeededFailure();

  @override
  bool operator ==(Object other) => other is NewerAppNeededFailure;

  @override
  int get hashCode => (NewerAppNeededFailure).hashCode;

  @override
  String toString() => 'NewerAppNeededFailure()';
}
