import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/features/result/domain/phone_number_display.dart';

import '../../../support/contract_fixtures.dart';

void main() {
  group(
    'the numbers in the shared phone-number fixtures (phone-numbers/zambian-input-normalization.json)',
    () {
      final cases =
          (ContractFixtures.readFile('phone-numbers/zambian-input-normalization.json')
                  as List<Object?>)
              .cast<Map<String, Object?>>();

      test('the loader finds all 18 phone-number cases', () {
        expect(cases, hasLength(18));
      });

      for (final phoneCase in cases) {
        final storedNumber = phoneCase['expected'] as String?;
        final input = phoneCase['input']! as String;
        if (storedNumber == null) {
          test('"$input" is not a number a card can hold, and is shown exactly as given', () {
            expect(formatPhoneNumberForDisplay(input), input);
          });
        } else if (storedNumber.startsWith('+260')) {
          test(
            '$storedNumber (typed as "$input") is shown grouped, and reads back as the stored number',
            () {
              final displayed = formatPhoneNumberForDisplay(storedNumber);
              expect(displayed, matches(RegExp(r'^\+260 [0-9]{2} [0-9]{3} [0-9]{4}$')));
              expect(displayed.replaceAll(' ', ''), storedNumber);
            },
          );
        } else {
          test('$storedNumber (typed as "$input") is from another country and shown as stored', () {
            expect(formatPhoneNumberForDisplay(storedNumber), storedNumber);
          });
        }
      }
    },
  );

  test('a Zambian number is grouped as the station confirmed it', () {
    expect(formatPhoneNumberForDisplay('+260977123456'), '+260 97 712 3456');
    expect(formatPhoneNumberForDisplay('+260211123456'), '+260 21 112 3456');
  });

  test('other countries, and Zambian numbers of the wrong length, are shown as stored', () {
    expect(formatPhoneNumberForDisplay('+27821234567'), '+27821234567');
    expect(formatPhoneNumberForDisplay('+2600977123456'), '+2600977123456');
    expect(formatPhoneNumberForDisplay('+26097712345'), '+26097712345');
    expect(formatPhoneNumberForDisplay('+260977123456\n'), '+260977123456\n');
  });
}
