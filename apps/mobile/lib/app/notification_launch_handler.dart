import 'dart:async';

import 'package:device_services/device_services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/app/app_providers.dart';
import 'package:lookup_listener/app/app_route.dart';
import 'package:lookup_listener/app/app_router.dart';
import 'package:lookup_listener/app/pending_destination.dart';
import 'package:lookup_listener/core/identifiers/uuid_shape.dart';
import 'package:lookup_listener/features/history/data/history_providers.dart';
import 'package:lookup_listener/features/history/data/history_repository.dart';
import 'package:lookup_listener/features/history/domain/history_entry.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';

/// Opens what a saved clip's notification points at (P6 design §2.16, §3.15; P6-OFFLINE-21,
/// P6-STRUCTURE-02): its tap starts the app, or brings it back, with the recognition id as the
/// launch extra.
///
/// The id is honoured only when it is a lower-case UUID and History holds an entry for it that a
/// notification was posted for; anything else is ignored. `MainActivity` is exported for the
/// launcher, so another app could start it with that extra; with this check it can at most reopen a
/// result this phone was already told about, and only if it knows the random id (fact 26).
///
/// A match opens its saved result at `/r/<id>`; a saved chooser opens "Which station?" (T51); a clip
/// not recognised opens the History tab. During an identify nothing is interrupted: the place is
/// kept as the pending destination, and a chooser is then reached from its History row.
class NotificationLaunchHandler {
  NotificationLaunchHandler({
    required DeviceServices deviceServices,
    required HistoryRepository history,
    required PendingDestination pendingDestination,
    required RecognitionState Function() readFlowState,
    required void Function(String location) go,
    required void Function(HistoryAwaitingChoiceEntry entry) openSavedChooser,
  }) : _deviceServices = deviceServices,
       _history = history,
       _pendingDestination = pendingDestination,
       _readFlowState = readFlowState,
       _go = go,
       _openSavedChooser = openSavedChooser;

  final DeviceServices _deviceServices;
  final HistoryRepository _history;
  final PendingDestination _pendingDestination;
  final RecognitionState Function() _readFlowState;
  final void Function(String location) _go;
  final void Function(HistoryAwaitingChoiceEntry entry) _openSavedChooser;
  StreamSubscription<String>? _subscription;

  /// Opens the id the app was started with, if any, and then each one that arrives while it runs.
  Future<void> start() async {
    _subscription ??= _deviceServices.launchRecognitionIds.listen((id) => unawaited(open(id)));
    final launchId = await _deviceServices.takeLaunchRecognitionId();
    if (launchId != null) await open(launchId);
  }

  void dispose() {
    unawaited(_subscription?.cancel());
    _subscription = null;
  }

  /// Opens what [recognitionId] names, when it may (above). Never throws.
  Future<void> open(String recognitionId) async {
    try {
      if (!UuidShape.isLowerCaseUuid(recognitionId)) return;
      if (!await _history.wasNotified(recognitionId)) return;
      final view = await _history.readView();
      final entry = view.entries.where((entry) => entry.entryId == recognitionId).firstOrNull;
      if (entry == null) return;
      final isIdle = _readFlowState() is IdleState;
      switch (entry) {
        case HistoryResultEntry():
          _land(AppRoute.savedResultLocation(recognitionId), isIdle: isIdle);
        case HistoryAwaitingChoiceEntry():
          if (isIdle) {
            _openSavedChooser(entry);
          } else {
            _pendingDestination.keep(AppRoute.history.path);
          }
        case HistoryNotIdentifiedEntry():
          _land(AppRoute.history.path, isIdle: isIdle);
      }
    } on Object {
      // A tap that cannot be followed opens the app as it was; nothing else to do.
    }
  }

  void _land(String location, {required bool isIdle}) {
    if (isIdle) {
      _go(location);
    } else {
      _pendingDestination.keep(location);
    }
  }
}

/// The app's launch handler, wired to its router, History and flow; `bootstrap()` starts it after
/// the first frame, and the journey tests start it the same way.
final Provider<NotificationLaunchHandler> notificationLaunchHandlerProvider =
    Provider<NotificationLaunchHandler>((ref) {
      final handler = NotificationLaunchHandler(
        deviceServices: ref.watch(deviceServicesProvider),
        history: ref.watch(historyRepositoryProvider),
        pendingDestination: ref.watch(pendingDestinationProvider),
        readFlowState: () => ref.read(recognitionFlowProvider),
        go: (location) => ref.read(appRouterProvider).go(location),
        openSavedChooser: (entry) => ref
            .read(recognitionFlowProvider.notifier)
            .openSavedChooser(
              recognitionId: entry.entryId,
              candidates: entry.candidates,
              answer: entry.answerBody,
              capturedAtOnPhone: entry.capturedAtOnPhone,
            ),
      );
      ref.onDispose(handler.dispose);
      return handler;
    }, retry: (retryCount, error) => null);
