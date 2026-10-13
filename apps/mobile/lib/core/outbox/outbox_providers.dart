import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'outbox_store.dart';

/// The outbox on disk (P6 design §3.6, §3.8), which the recognition flow queues choices in and the
/// sender empties.
///
/// It needs the app's support folder and this engine's identity, which `lib/app` provides, so
/// `bootstrap()` gives it through `appServiceOverrides`; tests override it with a store over a
/// temporary folder. Reading it without that override is a mistake in the app's set-up, not
/// something a listener can cause.
final Provider<OutboxStore> outboxStoreProvider = Provider<OutboxStore>(
  (ref) => throw UnimplementedError(
    'Override outboxStoreProvider at start-up with the app OutboxStore.',
  ),
  retry: (retryCount, error) => null,
);
