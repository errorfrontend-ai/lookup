import 'package:lookup_listener/features/identify/domain/account_result_outcome.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';

/// A recognition flow for screen and router tests: it shows the state the test gives it and
/// records which of its methods were called, in order, doing nothing else (no recorder,
/// permission or network). Tests prove with it that each button calls the right method; the
/// transitions themselves are proved with the real flow over fakes.
class RecordingRecognitionFlow extends RecognitionFlow {
  RecordingRecognitionFlow(this._firstState);

  final RecognitionState _firstState;

  /// The names of the methods called, e.g. `['identify', 'backToHome']`.
  final List<String> calls = [];

  /// What asking for the result held back by the account gate comes to (ADR-005).
  AccountResultOutcome nextAccountResultOutcome = AccountResultOutcome.shown;

  @override
  RecognitionState build() => _firstState;

  /// Moves to [next], as the real flow would after some event.
  void show(RecognitionState next) => state = next;

  @override
  Future<void> identify() async => calls.add('identify');

  @override
  Future<void> allowMicrophone() async => calls.add('allowMicrophone');

  @override
  Future<void> openPhoneSettings() async => calls.add('openPhoneSettings');

  @override
  Future<void> tryNow() async => calls.add('tryNow');

  @override
  Future<void> tryAgain() async => calls.add('tryAgain');

  @override
  void backToHome() => calls.add('backToHome');

  @override
  Future<AccountResultOutcome> showResultAfterAccount() async {
    calls.add('showResultAfterAccount');
    return nextAccountResultOutcome;
  }

  @override
  void openSavedAccountGate({required String recognitionId, required DateTime capturedAtOnPhone}) =>
      calls.add('openSavedAccountGate($recognitionId)');

  /// Recorded with its station and the "Remember" tick, e.g.
  /// `chooseStation(0192a6c4-…-000000000002, remembered)`.
  @override
  void chooseStation({required String stationId, required bool isRemembered}) =>
      calls.add('chooseStation($stationId, ${isRemembered ? 'remembered' : 'not remembered'})');
}
