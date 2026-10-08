import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/app/app_route.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/busy_screen.dart';
import 'package:lookup_listener/features/identify/presentation/error_screen.dart';
import 'package:lookup_listener/features/identify/presentation/home_screen.dart';
import 'package:lookup_listener/features/identify/presentation/identifying_screen.dart';
import 'package:lookup_listener/features/identify/presentation/listening_screen.dart';
import 'package:lookup_listener/features/identify/presentation/no_match_screen.dart';
import 'package:lookup_listener/features/identify/presentation/permission_screen.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:lookup_listener/features/result/presentation/result_screen.dart';

/// What one route's page shows: the screen for the newest recognition state that belongs to
/// [route] (design §3.6, S4-D5).
///
/// It keeps showing that state after the flow has moved on, while the router fades the page out,
/// so a leaving screen never flashes another state's content. Screens never navigate: they call
/// the flow, and the router follows.
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

  /// The screen for [state]: an exhaustive switch with no default branch (S4-STATE-09).
  Widget _screenFor(RecognitionState state) => switch (state) {
    IdleState() => const HomeScreen(),
    PermissionNeededState(:final microphoneAccess) => PermissionScreen(
      microphoneAccess: microphoneAccess,
    ),
    RecordingState(:final levelFraction, :final secondsLeft) => ListeningScreen(
      levelFraction: levelFraction,
      secondsLeft: secondsLeft,
    ),
    UploadingState() => const IdentifyingScreen(),
    MatchedState(:final result) || FallbackState(:final result) => ResultScreen(
      result: result,
      onBackToHome: ref.read(recognitionFlowProvider.notifier).backToHome,
    ),
    NoMatchState() => const NoMatchScreen(),
    BusyState(:final retryDelaySeconds, :final secondsUntilRetry) => BusyScreen(
      retryDelaySeconds: retryDelaySeconds,
      secondsUntilRetry: secondsUntilRetry,
    ),
    ErrorState(:final failure) => ErrorScreen(failure: failure),
  };
}
