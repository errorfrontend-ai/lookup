import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/error_reporting/personal_data_scrubber.dart';

void main() {
  group(
    "the server scrubber's cases (apps/api/test/client-errors.test.ts), with the same results",
    () {
      for (final (description, input, expected) in [
        ('an email', 'failed for a.b+c@example.co.zm today', 'failed for [email] today'),
        ('a phone number', 'call 0977 123 456 now', 'call [number] now'),
        ('an international number', 'call +260-977-123-456', 'call [number]'),
        ('a long token', 'token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9xyz', 'token [token]'),
        (
          'a query string',
          'GET https://api.example/x?email=a&b=c failed',
          'GET https://api.example/x failed',
        ),
      ]) {
        test('removes $description', () {
          expect(PersonalDataScrubber.scrub(input), expected);
        });
      }

      test('keeps only the path of a location', () {
        expect(PersonalDataScrubber.pathOnly('/stations/x/ads?cursor=abc#top'), '/stations/x/ads');
      });

      test("the server test's whole report: message, stack and location", () {
        final message = PersonalDataScrubber.scrub(
          'Cannot read name of undefined for owner@station.example +260 977 123 456',
        );
        expect(message, isNot(contains('owner@station.example')));
        expect(message, isNot(contains('977')));
        final stack = PersonalDataScrubber.scrub(
          'TypeError: x\n    at render (https://portal.example/assets/app.js?token='
          'abcdefghijklmnopqrstuvwxyz0123456789:1:2)',
        );
        expect(stack, isNot(contains('abcdefghijklmnopqrstuvwxyz0123456789')));
        final location = PersonalDataScrubber.scrub(
          PersonalDataScrubber.pathOnly('/stations/abc/ads?search=secret#top'),
        );
        expect(location, '/stations/abc/ads');
      });
    },
  );

  test('LA-PRIVACY-04: a message that quotes the email and the sign-up ticket of a listener loses both', () {
    final ticket = 'Tk3' * 18;
    final message = PersonalDataScrubber.scrub('create failed for Listener.One+tag@example.com with ticket $ticket');
    expect(message, 'create failed for [email] with ticket [token]');
  });

  group('the secrets the phone knows', () {
    const installId = '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f';
    // Shaped like the API's install tokens: a signed JWT whose three parts are each long.
    const installToken =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.'
        'eyJzdWIiOiIwMTkyYTZjNC03ZTFmLTdhMmItOGMzZC00ZTVmNmE3YjhjOWQifQ.'
        'c2lnbmF0dXJlLXRoYXQtaXMtbG9uZy1lbm91Z2g';

    test('the install id becomes [install], in either case', () {
      expect(
        PersonalDataScrubber.scrub(
          'install $installId and ${installId.toUpperCase()}',
          installId: installId,
        ),
        'install [install] and [install]',
      );
    });

    test('the install token becomes [token], even when its parts are short', () {
      const shortPartsToken = 'abc.def.ghi';
      expect(
        PersonalDataScrubber.scrub(
          'Bearer $installToken / $shortPartsToken',
          installToken: installToken,
        ),
        'Bearer [token] / abc.def.ghi',
      );
      expect(
        PersonalDataScrubber.scrub('sent $shortPartsToken', installToken: shortPartsToken),
        'sent [token]',
      );
    });

    test('a long token or install id is caught by the patterns even when not known', () {
      expect(PersonalDataScrubber.scrub('id $installId'), 'id [token]');
      expect(PersonalDataScrubber.scrub('header $installToken'), 'header [token].[token].[token]');
    });

    test('a known secret too short to be real is not replaced everywhere', () {
      expect(PersonalDataScrubber.scrub('a b c', installId: 'a', installToken: 'b'), 'a b c');
    });
  });

  test('text with nothing personal is unchanged', () {
    const text = 'Null check operator used on a null value at /listening (8 s, 24 kbit/s)';
    expect(PersonalDataScrubber.scrub(text), text);
  });
}
