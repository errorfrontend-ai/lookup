import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/domain/recognition_state.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';

/// S4-STATE-01: the identify flow is one Riverpod Notifier over the sealed recognition state, so every
/// screen reads one value and the compiler checks that each state is handled (design §3.4, S4-D4).
void main() {
  test('the identify flow is a Notifier over the sealed recognition state (S4-STATE-01)', () {
    expect(recognitionFlowProvider, isA<NotifierProvider<RecognitionFlow, RecognitionState>>());
  });
}
