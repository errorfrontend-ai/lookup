import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/account/domain/account_rules.dart';
import 'package:lookup_listener/features/account/domain/listener_gender.dart';

/// The checks the sign-up form makes on the phone before it asks the server (ADR-005, LA-APP-03 to -05).
void main() {
  group('an email', () {
    test('is read trimmed and lower-cased, so one address is one account', () {
      expect(AccountRules.normaliseEmail('  Listener@Example.COM '), 'listener@example.com');
    });

    for (final email in ['listener@example.com', 'a.b+c@sub.example.co.zm', ' Spaces@Around.com ']) {
      test('"$email" could be one', () => expect(AccountRules.looksLikeEmail(email), isTrue));
    }

    for (final email in ['', 'listener', 'listener@', '@example.com', 'a b@example.com', 'a@b', 'a@@example.com', 'listener@example', '${'a' * 250}@example.com']) {
      test('"${email.length > 30 ? '${email.substring(0, 12)}…' : email}" is not one', () => expect(AccountRules.looksLikeEmail(email), isFalse));
    }
  });

  group('the code', () {
    for (final code in ['123456', '000000', '042817']) {
      test('$code is complete', () => expect(AccountRules.isCompleteCode(code), isTrue));
    }
    for (final code in ['', '12345', '1234567', '12345a', ' 123456', '12 345']) {
      test('"$code" is not', () => expect(AccountRules.isCompleteCode(code), isFalse));
    }
  });

  group('the age', () {
    test('is a whole number of one or two digits from 1 to 99', () {
      expect(AccountRules.readAge('13'), 13);
      expect(AccountRules.readAge(' 99 '), 99);
      expect(AccountRules.readAge('1'), 1);
    });

    for (final text in ['', '0', '00', '100', '-5', '30.5', '3a', 'thirty', '123']) {
      test('"$text" is not one', () => expect(AccountRules.readAge(text), isNull));
    }

    test('under 13 is read as typed but cannot create an account', () {
      expect(AccountRules.readAge('12'), 12);
      expect(AccountRules.isOldEnough(12), isFalse);
      expect(AccountRules.isOldEnough(13), isTrue);
      expect(AccountRules.isOldEnough(99), isTrue);
    });
  });

  test('the limits and the consent wording are the contract\'s', () {
    expect(AccountRules.minimumAge, 13);
    expect(AccountRules.maximumAge, 99);
    expect(AccountRules.codeLength, 6);
    expect(AccountRules.longestEmailLength, 254);
    expect(AccountRules.consentTextVersion, 'listener-consent-2026-10');
  });

  test('the four genders carry the contract\'s names', () {
    expect({for (final gender in ListenerGender.values) gender.apiName}, {'FEMALE', 'MALE', 'ANOTHER', 'PREFER_NOT_TO_SAY'});
  });
}
