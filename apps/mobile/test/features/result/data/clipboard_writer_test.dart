import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/result/data/clipboard_writer.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late List<MethodCall> platformCalls;

  void answerPlatformCalls(Future<Object?> Function(MethodCall call) answer) {
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) {
      platformCalls.add(call);
      return answer(call);
    });
    addTearDown(() => messenger.setMockMethodCallHandler(SystemChannels.platform, null));
  }

  setUp(() => platformCalls = []);

  test('copies the text exactly through the system clipboard', () async {
    answerPlatformCalls((call) async => null);

    expect(await const SystemClipboardWriter().copyText('+260977123456'), isTrue);

    expect(platformCalls, hasLength(1));
    expect(platformCalls.single.method, 'Clipboard.setData');
    expect(platformCalls.single.arguments, {'text': '+260977123456'});
  });

  test('a clipboard the platform refuses answers false and throws nothing', () async {
    answerPlatformCalls((call) async => throw PlatformException(code: 'unavailable'));

    expect(await const SystemClipboardWriter().copyText('+260977123456'), isFalse);
  });

  test('the provider gives the system clipboard', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    expect(container.read(clipboardWriterProvider), isA<SystemClipboardWriter>());
  });
}
