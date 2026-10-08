import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';

/// Makes Android's system Back do what a screen's own Back or Close does (design §2.1, §3.6): it
/// calls the flow's `backToHome()`, and the router follows the state Home. The page itself never
/// pops, so the stack stays flat and Back can never leave a screen showing a state that has ended.
class SystemBackToHome extends ConsumerWidget {
  const SystemBackToHome({super.key, required this.child});

  /// The screen.
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return PopScope<Object?>(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) ref.read(recognitionFlowProvider.notifier).backToHome();
      },
      child: child,
    );
  }
}
