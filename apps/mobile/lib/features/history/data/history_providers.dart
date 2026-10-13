import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/time/clock.dart';
import 'package:lookup_listener/features/history/data/history_repository.dart';
import 'package:lookup_listener/features/history/domain/history_view.dart';

/// History on the phone (P6 design §3.6, §3.14): the recognition flow saves results in it, the
/// History tab and the saved result read it.
///
/// It needs the app's support folder, this engine's identity, the crash reporter, the clock and the
/// recognize answer's reader, which `lib/app` provides, so `bootstrap()` gives it through
/// `appServiceOverrides`; tests override it with one over a temporary folder. Reading it without
/// that override is a mistake in the app's set-up, not something a listener can cause.
final Provider<HistoryRepository> historyRepositoryProvider = Provider<HistoryRepository>(
  (ref) => throw UnimplementedError(
    'Override historyRepositoryProvider at start-up with the app HistoryRepository.',
  ),
  retry: (retryCount, error) => null,
);

/// What History holds, newest first, given again after every save or clear (P6 design §3.6): the
/// History tab, the saved result at `/r/<id>` and the Result's "Saved to History" watch it.
final StreamProvider<HistoryView> historyViewProvider = StreamProvider<HistoryView>(
  (ref) => ref.watch(historyRepositoryProvider).watchView(),
  retry: (retryCount, error) => null,
);

/// The clock History's rows read "Today" and "Yesterday" against. The real clock in the app; tests
/// override it with a fake one.
final Provider<Clock> historyClockProvider = Provider<Clock>(
  (ref) => Clock(),
  retry: (retryCount, error) => null,
);
