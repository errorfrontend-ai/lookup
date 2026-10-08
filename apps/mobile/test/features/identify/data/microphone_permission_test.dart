import 'package:flutter/services.dart' show PlatformException;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/identify/data/microphone_permission.dart';
import 'package:lookup_listener/features/identify/domain/microphone_access.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The phone's side of the permission, scripted: the status a check reads and the answer the
/// prompt gives, with every call counted.
final class _ScriptedPhone {
  PermissionStatus status = PermissionStatus.denied;
  PermissionStatus answerToPrompt = PermissionStatus.denied;
  int statusReadCount = 0;
  int promptCount = 0;
  int settingsOpenCount = 0;
  bool? hasAskedWhenPromptShowed;
  Object? settingsError;

  PermissionHandlerMicrophonePermission permission() => PermissionHandlerMicrophonePermission(
    readStatus: () async {
      statusReadCount++;
      return status;
    },
    requestStatus: () async {
      promptCount++;
      hasAskedWhenPromptShowed = (await SharedPreferences.getInstance()).getBool(
        PermissionHandlerMicrophonePermission.hasAskedKey,
      );
      return status = answerToPrompt;
    },
    openAppSettingsPage: () async {
      settingsOpenCount++;
      final error = settingsError;
      if (error != null) throw error;
      return true;
    },
  );
}

void main() {
  late _ScriptedPhone phone;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    phone = _ScriptedPhone();
  });

  group('reading the status, with no prompt (S4-PERMISSION-01)', () {
    test('denied before this install ever asked is "not asked yet"', () async {
      expect(await phone.permission().readAccess(), MicrophoneAccess.notAskedYet);
      expect(phone.promptCount, 0);
    });

    test('denied after asking is "refused once"', () async {
      SharedPreferences.setMockInitialValues({
        PermissionHandlerMicrophonePermission.hasAskedKey: true,
      });
      expect(await phone.permission().readAccess(), MicrophoneAccess.refusedOnce);
      expect(phone.promptCount, 0);
    });

    test('every status maps to one access, and none of them prompts', () async {
      const expected = {
        PermissionStatus.granted: MicrophoneAccess.granted,
        PermissionStatus.limited: MicrophoneAccess.granted,
        PermissionStatus.provisional: MicrophoneAccess.granted,
        PermissionStatus.permanentlyDenied: MicrophoneAccess.refusedForGood,
        PermissionStatus.restricted: MicrophoneAccess.refusedForGood,
        PermissionStatus.denied: MicrophoneAccess.notAskedYet,
      };
      expect(expected.keys, unorderedEquals(PermissionStatus.values));
      for (final MapEntry(key: status, value: access) in expected.entries) {
        phone.status = status;
        expect(await phone.permission().readAccess(), access, reason: '$status');
      }
      expect(phone.promptCount, 0);
    });
  });

  group('asking, only from "Allow microphone" (S4-PERMISSION-02)', () {
    test('allowed in the prompt is granted', () async {
      phone.answerToPrompt = PermissionStatus.granted;
      expect(await phone.permission().requestAccess(), MicrophoneAccess.granted);
      expect(phone.promptCount, 1);
    });

    test('refused in the prompt is "refused once", and a later read says so too', () async {
      final permission = phone.permission();
      expect(await permission.requestAccess(), MicrophoneAccess.refusedOnce);
      expect(await permission.readAccess(), MicrophoneAccess.refusedOnce);
    });

    test('"permanently denied" comes only from a request: refused for good (T5)', () async {
      // Android's status check still says "denied" after the second refusal; only the request,
      // answered at once with no prompt, says the system will not ask again.
      SharedPreferences.setMockInitialValues({
        PermissionHandlerMicrophonePermission.hasAskedKey: true,
      });
      final permission = phone.permission();
      expect(await permission.readAccess(), MicrophoneAccess.refusedOnce);
      phone.answerToPrompt = PermissionStatus.permanentlyDenied;
      expect(await permission.requestAccess(), MicrophoneAccess.refusedForGood);
    });

    test('restricted by the phone is refused for good', () async {
      phone.answerToPrompt = PermissionStatus.restricted;
      expect(await phone.permission().requestAccess(), MicrophoneAccess.refusedForGood);
    });

    test('the install remembers that it asked before the prompt shows', () async {
      await phone.permission().requestAccess();
      expect(phone.hasAskedWhenPromptShowed, isTrue);
      final preferences = await SharedPreferences.getInstance();
      expect(preferences.getBool('has_asked_for_microphone'), isTrue);
    });

    test('the prompt never answers "not asked yet"', () async {
      for (final status in PermissionStatus.values) {
        phone.answerToPrompt = status;
        expect(
          await phone.permission().requestAccess(),
          isNot(MicrophoneAccess.notAskedYet),
          reason: '$status',
        );
      }
    });
  });

  group('the phone settings (T6)', () {
    test('open the app page and resolve to whether it opened', () async {
      expect(await phone.permission().openSettings(), isTrue);
      expect(phone.settingsOpenCount, 1);
      expect(phone.promptCount, 0);
    });

    test('a platform that cannot open them resolves to false rather than throwing', () async {
      phone.settingsError = PlatformException(code: 'no_activity');
      expect(await phone.permission().openSettings(), isFalse);
    });
  });
}
