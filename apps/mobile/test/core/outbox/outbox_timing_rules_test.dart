import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/outbox/outbox_timing_rules.dart';

import '../../support/contract_fixtures.dart';

/// The outbox's numbers equal the shared `listener-outbox/timing-rules.json` (P6 design §4.2), and
/// the backoff grows as contract R8 says (P6-OUTBOX-04).
void main() {
  final fixture =
      ContractFixtures.readFile('listener-outbox/timing-rules.json')! as Map<String, Object?>;
  final rules = fixture['timing_rules']! as Map<String, Object?>;

  test('every value of timing-rules.json is the app\'s, and the app has no other', () {
    expect(rules, {
      'maximum_stored_clips': OutboxTimingRules.maximumStoredClips,
      'stored_clip_lifetime_seconds': OutboxTimingRules.storedClipLifetimeSeconds,
      'follow_up_item_lifetime_seconds': OutboxTimingRules.followUpItemLifetimeSeconds,
      'maximum_follow_up_items': OutboxTimingRules.maximumFollowUpItems,
      'maximum_queued_client_error_reports': OutboxTimingRules.maximumQueuedClientErrorReports,
      'sending_delay_maximum_seconds': OutboxTimingRules.standardSendingDelayMaximumSeconds,
      'sending_delay_for_new_item_while_online_maximum_seconds':
          OutboxTimingRules.sendingDelayForNewItemWhileOnlineMaximumSeconds,
      'deferred_shed_retry_after_minimum_seconds':
          OutboxTimingRules.deferredShedRetryAfterMinimumSeconds,
      'deferred_shed_retry_after_maximum_seconds':
          OutboxTimingRules.deferredShedRetryAfterMaximumSeconds,
      'longest_honoured_retry_after_seconds': OutboxTimingRules.longestHonouredRetryAfterSeconds,
      'backoff_first_wait_seconds': OutboxTimingRules.standardBackoffFirstWaitSeconds,
      'backoff_longest_wait_seconds': OutboxTimingRules.backoffLongestWaitSeconds,
      'backoff_lowest_jitter_factor': OutboxTimingRules.backoffLowestJitterFactor,
      'registrations_after_refused_token_per_run':
          OutboxTimingRules.registrationsAfterRefusedTokenPerRun,
      'deferred_allowance_per_hour': OutboxTimingRules.deferredAllowancePerHour,
      'live_server_wait_milliseconds': OutboxTimingRules.liveServerWaitMilliseconds,
      'deferred_server_wait_milliseconds': OutboxTimingRules.deferredServerWaitMilliseconds,
    });
  });

  test('the standard rules, every staging and production build\'s, wait 0 to 120 s and back off '
      'from 30 s', () {
    expect(OutboxTimingRules.standard.sendingDelayMaximumSeconds, 120);
    expect(OutboxTimingRules.standard.backoffFirstWaitSeconds, 30);
    expect(OutboxTimingRules.standard.newItemSendingDelayMaximumSeconds, 10);
    expect(AppConfiguration.standardOutboxSendingDelayMaximumSeconds, 120);
    expect(AppConfiguration.standardOutboxBackoffFirstWaitSeconds, 30);
  });

  test('a development build\'s lower sending delay also shortens a new item\'s wait', () {
    const development = OutboxTimingRules(
      sendingDelayMaximumSeconds: 5,
      backoffFirstWaitSeconds: 5,
    );
    expect(development.newItemSendingDelayMaximumSeconds, 5);
  });

  test('a Retry-After is honoured as it is, clamped to 1 to 3,600 s', () {
    expect(OutboxTimingRules.honouredRetryAfterSeconds(187), 187);
    expect(OutboxTimingRules.honouredRetryAfterSeconds(0), 1);
    expect(OutboxTimingRules.honouredRetryAfterSeconds(-5), 1);
    expect(OutboxTimingRules.honouredRetryAfterSeconds(7200), 3600);
  });

  group('the backoff: min(30 × 2^(n−1), 1800) s × a factor from 0.5 to 1.0 (P6-OUTBOX-04)', () {
    test('its bounds grow with each failure, up to half an hour', () {
      for (final (failureCount, baseSeconds) in [
        (1, 30),
        (2, 60),
        (3, 120),
        (4, 240),
        (5, 480),
        (6, 960),
        (7, 1800),
        (8, 1800),
        (40, 1800),
      ]) {
        final shortest = OutboxTimingRules.standard.backoffAfter(
          failureCount: failureCount,
          random: _FixedRandom(0),
        );
        final longest = OutboxTimingRules.standard.backoffAfter(
          failureCount: failureCount,
          random: _FixedRandom(0.999999),
        );
        expect(
          shortest,
          Duration(milliseconds: baseSeconds * 500),
          reason: 'failure $failureCount',
        );
        expect(longest.inMilliseconds, closeTo(baseSeconds * 1000, 1), reason: '$failureCount');
      }
    });

    test("drawn from a seeded random source, each wait lies inside its own failure's bounds", () {
      final random = Random(7);
      for (var failureCount = 1; failureCount <= 9; failureCount++) {
        final baseSeconds = min(30 * pow(2, failureCount - 1).toInt(), 1800);
        expect(
          OutboxTimingRules.standard
              .backoffAfter(failureCount: failureCount, random: random)
              .inMilliseconds,
          inInclusiveRange(baseSeconds * 500, baseSeconds * 1000),
          reason: 'failure $failureCount',
        );
      }
    });

    test('a development build starts from 5 s: at most 5, 10, then 20 s apart (amendment A1)', () {
      const development = OutboxTimingRules(backoffFirstWaitSeconds: 5);
      expect(
        [
          for (var failureCount = 1; failureCount <= 3; failureCount++)
            development
                .backoffAfter(failureCount: failureCount, random: _FixedRandom(0.999999))
                .inSeconds,
        ],
        [5, 10, 20],
      );
    });
  });
}

/// A random source that always draws [value].
class _FixedRandom implements Random {
  _FixedRandom(this.value);

  final double value;

  @override
  double nextDouble() => value;

  @override
  int nextInt(int max) => (value * max).floor();

  @override
  bool nextBool() => value >= 0.5;
}
