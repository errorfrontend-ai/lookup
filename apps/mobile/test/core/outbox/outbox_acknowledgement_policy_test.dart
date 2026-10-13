import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/outbox/outbox_acknowledgement_policy.dart';
import 'package:lookup_listener/core/outbox/outbox_action.dart';
import 'package:lookup_listener/core/outbox/outbox_item_kind.dart';
import 'package:lookup_listener/core/outbox/outbox_send_answer.dart';

import '../../support/contract_fixtures.dart';

/// One row of `listener-outbox/acknowledgement-rules.json`.
final class _Row {
  _Row(Map<String, Object?> json)
    : kind = OutboxItemKind.fromWireName(json['item_kind'])!,
      answer = json['answer']! as String,
      httpStatus = json['http_status'] as int?,
      httpStatusClass = json['http_status_class'] as String?,
      errorCode = json['error_code'] as String?,
      retryAfterSeconds = json['retry_after_seconds'] as int?,
      action = _actionOf(json['action']! as String, json['wait'] as Map<String, Object?>?);

  final OutboxItemKind kind;
  final String answer;
  final int? httpStatus;
  final String? httpStatusClass;
  final String? errorCode;
  final int? retryAfterSeconds;
  final OutboxAction action;

  @override
  String toString() =>
      '${kind.wireName} $answer ${httpStatus ?? httpStatusClass ?? ''} ${errorCode ?? ''} '
              '${retryAfterSeconds == null ? '' : 'Retry-After $retryAfterSeconds'}'
          .replaceAll(RegExp(r'\s+'), ' ')
          .trim();

  static OutboxAction _actionOf(String action, Map<String, Object?>? wait) => switch (action) {
    'DELETE' => const OutboxDelete(isReported: false),
    'DELETE_AND_REPORT' => const OutboxDelete(isReported: true),
    'ITEM_WAITS' => OutboxItemWaits(seconds: wait!['seconds']! as int),
    'ITEM_BACKS_OFF' => const OutboxItemBacksOff(endsRun: false),
    'ITEM_BACKS_OFF_AND_RUN_ENDS' => const OutboxItemBacksOff(endsRun: true),
    'PAUSE_GROUP' => OutboxPauseGroup(
      wait: switch (wait!['kind']) {
        'SECONDS' => OutboxWaitSeconds(wait['seconds']! as int),
        'RANDOM_SECONDS' => OutboxWaitRandomSeconds(
          minimumSeconds: wait['minimum_seconds']! as int,
          maximumSeconds: wait['maximum_seconds']! as int,
        ),
        final other => throw StateError('A wait the test does not know: $other'),
      },
    ),
    'PAUSE_ALL_UNTIL_APP_VERSION_CHANGES' => const OutboxPauseAllUntilAppVersionChanges(),
    'REGISTER_AGAIN_AND_RESEND' => const OutboxRegisterAgainAndResend(),
    final other => throw StateError('An action the test does not know: $other'),
  };
}

/// The acknowledgement policy against the shared rules (P6 design §3.9 point 8; contract R9;
/// P6-D39): every row of the fixture, and every status from 200 to 599 for every kind.
void main() {
  final fixture =
      ContractFixtures.readFile('listener-outbox/acknowledgement-rules.json')!
          as Map<String, Object?>;
  final rows = [
    for (final row in fixture['rows']! as List<Object?>) _Row(row! as Map<String, Object?>),
  ];

  /// The rows of [kind] that describe a status given with no code and no Retry-After.
  _Row? exactRow(OutboxItemKind kind, int status) => rows
      .where(
        (row) =>
            row.kind == kind &&
            row.answer == 'HTTP' &&
            row.httpStatus == status &&
            row.errorCode == null &&
            row.retryAfterSeconds == null,
      )
      .firstOrNull;

  _Row? classRow(OutboxItemKind kind, int status) => rows
      .where(
        (row) =>
            row.kind == kind && row.answer == 'HTTP' && row.httpStatusClass == '${status ~/ 100}xx',
      )
      .firstOrNull;

  test('the fixture has rows for all five kinds and every answer type', () {
    expect(rows.map((row) => row.kind).toSet(), OutboxItemKind.values.toSet());
    expect(rows.map((row) => row.answer).toSet(), {
      'HTTP',
      'HTTP_WITH_UNREADABLE_BODY',
      'NO_ANSWER',
      'PHONE_FAULT',
    });
    expect(rows.length, greaterThanOrEqualTo(150));
  });

  group('every row of acknowledgement-rules.json', () {
    for (final row in rows) {
      test('$row → ${row.action}', () {
        final answer = switch (row.answer) {
          'NO_ANSWER' => const OutboxNoAnswer(),
          'PHONE_FAULT' => const OutboxPhoneFault(problem: 'a fault in the app (StateError)'),
          'HTTP_WITH_UNREADABLE_BODY' => OutboxHttpAnswer(
            httpStatus: row.httpStatus!,
            isBodyUnreadable: true,
          ),
          _ => null,
        };
        if (answer != null) {
          expect(OutboxAcknowledgementPolicy.decide(row.kind, answer), row.action);
          return;
        }
        // A status row is checked with its status; a class row with every status of the class
        // that has no row of its own for this kind.
        final statuses = row.httpStatus != null
            ? [row.httpStatus!]
            : [
                for (
                  var status = int.parse(row.httpStatusClass![0]) * 100;
                  status < int.parse(row.httpStatusClass![0]) * 100 + 100;
                  status++
                )
                  if (!rows.any(
                    (other) =>
                        other.kind == row.kind &&
                        other.answer == 'HTTP' &&
                        other.httpStatus == status,
                  ))
                    status,
              ];
        expect(statuses, isNotEmpty);
        for (final status in statuses) {
          expect(
            OutboxAcknowledgementPolicy.decide(
              row.kind,
              OutboxHttpAnswer(
                httpStatus: status,
                errorCode: row.errorCode,
                retryAfterSeconds: row.retryAfterSeconds,
              ),
            ),
            row.action,
            reason: 'HTTP $status',
          );
        }
        // A status row with no code stands for any code no row names: an unknown code is handled
        // by its status (contract §1.0).
        if (row.httpStatus != null && row.errorCode == null) {
          expect(
            OutboxAcknowledgementPolicy.decide(
              row.kind,
              OutboxHttpAnswer(
                httpStatus: row.httpStatus!,
                errorCode: 'A_CODE_FROM_A_NEWER_SERVER',
                retryAfterSeconds: row.retryAfterSeconds,
              ),
            ),
            row.action,
            reason: 'an unknown code',
          );
        }
      });
    }
  });

  test('every status from 200 to 599 has an action for every kind, the one its row or its '
      'class\'s default row gives (P6-D39)', () {
    for (final kind in OutboxItemKind.values) {
      for (var status = 200; status < 600; status++) {
        final row = exactRow(kind, status) ?? classRow(kind, status);
        expect(row, isNotNull, reason: '${kind.wireName} HTTP $status has no row');
        expect(
          OutboxAcknowledgementPolicy.decide(kind, OutboxHttpAnswer(httpStatus: status)),
          row!.action,
          reason: '${kind.wireName} HTTP $status',
        );
      }
    }
  });

  group('for a station choice (contract §1.3)', () {
    OutboxAction decide(int status, {String? code, int? retryAfterSeconds}) =>
        OutboxAcknowledgementPolicy.decide(
          OutboxItemKind.stationChoice,
          OutboxHttpAnswer(
            httpStatus: status,
            errorCode: code,
            retryAfterSeconds: retryAfterSeconds,
          ),
        );

    test('204, accepted or repeated, deletes it, unreported', () {
      expect(decide(204), const OutboxDelete(isReported: false));
    });

    test(
      '400, 404 and both 422s delete it with a crash report: the phone sent something wrong',
      () {
        for (final (status, code) in [
          (400, 'VALIDATION_FAILED'),
          (404, 'NOT_FOUND'),
          (422, 'STATION_NOT_A_CANDIDATE'),
          (422, 'STATION_ALREADY_CHOSEN'),
        ]) {
          expect(decide(status, code: code), const OutboxDelete(isReported: true), reason: code);
        }
      },
    );

    test('401 registers again and resends it; 426 pauses everything until the app changes', () {
      expect(decide(401, code: 'INSTALL_TOKEN_INVALID'), const OutboxRegisterAgainAndResend());
      expect(
        decide(426, code: 'APP_UPDATE_REQUIRED'),
        const OutboxPauseAllUntilAppVersionChanges(),
      );
    });

    test('429 and a 503 with Retry-After pause the follow-ups; 500 and a bare 503 back off', () {
      expect(
        decide(429, code: 'RATE_LIMITED', retryAfterSeconds: 45),
        const OutboxPauseGroup(wait: OutboxWaitSeconds(45)),
      );
      expect(decide(429), const OutboxPauseGroup(wait: OutboxWaitSeconds(60)));
      expect(
        decide(503, code: 'SERVICE_UNAVAILABLE', retryAfterSeconds: 6),
        const OutboxPauseGroup(wait: OutboxWaitSeconds(6)),
      );
      expect(decide(500, code: 'INTERNAL'), const OutboxItemBacksOff(endsRun: false));
      expect(decide(503), const OutboxItemBacksOff(endsRun: false));
    });

    test('no answer backs off and ends the run; a phone fault deletes it with a report', () {
      expect(
        OutboxAcknowledgementPolicy.decide(OutboxItemKind.stationChoice, const OutboxNoAnswer()),
        const OutboxItemBacksOff(endsRun: true),
      );
      expect(
        OutboxAcknowledgementPolicy.decide(
          OutboxItemKind.stationChoice,
          const OutboxPhoneFault(problem: 'a fault in the app'),
        ),
        const OutboxDelete(isReported: true),
      );
    });
  });
}
