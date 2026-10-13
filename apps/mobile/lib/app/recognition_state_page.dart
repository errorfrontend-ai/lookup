import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/app/app_route.dart';
import 'package:lookup_listener/app/main_tab.dart';
import 'package:lookup_listener/app/pending_destination.dart';
import 'package:lookup_listener/app/result_beside_home.dart';
import 'package:lookup_listener/features/identify/domain/chooser_origin.dart';
import 'package:lookup_listener/features/history/data/history_providers.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/busy_screen.dart';
import 'package:lookup_listener/features/identify/presentation/choose_station_screen.dart';
import 'package:lookup_listener/features/identify/presentation/error_screen.dart';
import 'package:lookup_listener/features/identify/presentation/identifying_screen.dart';
import 'package:lookup_listener/features/identify/presentation/listening_screen.dart';
import 'package:lookup_listener/features/identify/presentation/no_match_screen.dart';
import 'package:lookup_listener/features/identify/presentation/permission_screen.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/identify/presentation/saved_offline_screen.dart';
import 'package:lookup_listener/features/result/presentation/result_screen.dart';

/// What one flow route's page shows: the screen for the newest recognition state that belongs to
/// [route] (design §3.6, S4-D5). Home, the `idle` state's screen, is the Identify tab of the tab
/// shell instead (P6 design §3.7).
///
/// It keeps showing that state after the flow has moved on, while the router fades the page out,
/// so a leaving screen never flashes another state's content. Screens never navigate: they call
/// the flow, and the router follows. The Result says "Saved to History" once History holds its
/// result (P6-HISTORY-14).
class RecognitionStatePage extends ConsumerStatefulWidget {
  const RecognitionStatePage({super.key, required this.route});

  final AppRoute route;

  @override
  ConsumerState<RecognitionStatePage> createState() => _RecognitionStatePageState();
}

class _RecognitionStatePageState extends ConsumerState<RecognitionStatePage> {
  RecognitionState? _shownState;

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(recognitionFlowProvider);
    if (AppRoute.forState(state) == widget.route) _shownState = state;
    final shownState = _shownState;
    // Only while a page is built for a state that has already passed: the router moves on at once.
    if (shownState == null) return const Scaffold();
    return _screenFor(shownState);
  }

  void _backToHome() => ref.read(recognitionFlowProvider.notifier).backToHome();

  /// Ends the flow at the History tab: the destination is kept before the flow goes idle, so the
  /// redirect lands there in one step.
  void _backToHistory() {
    ref.read(pendingDestinationProvider).keep(AppRoute.history.path);
    _backToHome();
  }

  /// A tab of the rail beside a Result: the Result is left, as with Back, and that tab opens.
  void _leaveResultFor(MainTab tab) {
    if (tab != MainTab.identify) ref.read(pendingDestinationProvider).keep(tab.route.path);
    _backToHome();
  }

  /// The screen for [state]: an exhaustive switch with no default branch (S4-STATE-09).
  Widget _screenFor(RecognitionState state) => switch (state) {
    // Never shown here: no flow route belongs to `idle`, whose screen is the Identify tab.
    IdleState() => const Scaffold(),
    PermissionNeededState(:final microphoneAccess) => PermissionScreen(
      microphoneAccess: microphoneAccess,
    ),
    RecordingState(:final levelFraction, :final secondsLeft) => ListeningScreen(
      levelFraction: levelFraction,
      secondsLeft: secondsLeft,
    ),
    UploadingState() => const IdentifyingScreen(),
    ChooseStationState(:final origin) => ChooseStationScreen(
      state: state,
      // T47: Cancel on a chooser opened from History goes back there (P6 design §2.6).
      onCancel: switch (origin) {
        ChooserOrigin.liveIdentify => _backToHome,
        ChooserOrigin.savedRecognition => _backToHistory,
      },
    ),
    SavedOfflineState() => SavedOfflineScreen(
      state: state,
      onBackToHome: _backToHome,
      // T49: History, where the clip shows as Pending, with no frame of Home (P6 design §3.7).
      onSeeInHistory: _backToHistory,
    ),
    // Beside Home in a side panel on a tablet (P6 design §3.19), full screen on a phone.
    MatchedState(:final result) || FallbackState(:final result) => ResultBesideHome(
      onSelectTab: _leaveResultFor,
      result: ResultScreen(
        result: result,
        onBackToHome: ref.read(recognitionFlowProvider.notifier).backToHome,
        isSavedToHistory:
            ref.watch(historyViewProvider).value?.holdsResult(result.recognitionId) ?? false,
        isReported:
            ref.watch(historyViewProvider).value?.resultFor(result.recognitionId)?.isReported ??
            false,
      ),
    ),
    NoMatchState() => const NoMatchScreen(),
    BusyState(:final retryDelaySeconds, :final secondsUntilRetry) => BusyScreen(
      retryDelaySeconds: retryDelaySeconds,
      secondsUntilRetry: secondsUntilRetry,
    ),
    ErrorState(:final failure) => ErrorScreen(failure: failure),
  };
}
