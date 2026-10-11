/**
 * What the listener app's outbox and the API must agree on (contract §3): the kinds of item the phone
 * keeps and sends later, the groups they pause in, the numbers both sides use, and the words of the
 * acknowledgement table. `fixtures/listener-outbox/timing-rules.json` holds the same numbers and
 * `fixtures/listener-outbox/acknowledgement-rules.json` the table's rows, for the app's tests; a
 * contracts test keeps the file and these values equal.
 */

/** Every kind of item the outbox holds. One sender sends them all, one request at a time. */
export const LISTENER_OUTBOX_ITEM_KINDS = ['DEFERRED_CLIP', 'STATION_CHOICE', 'ENGAGEMENT', 'RECOGNITION_REPORT', 'CLIENT_ERROR_REPORT'] as const;
export type ListenerOutboxItemKind = (typeof LISTENER_OUTBOX_ITEM_KINDS)[number];

/**
 * Items pause by the server allowance they use: clips (POST /recognize), follow-ups (the choice, taps and
 * reports share one per-install allowance) and crash reports (the public POST /client-errors). A 429 or
 * 503 pauses only the group of the item that got it; a 426 pauses every group.
 */
export const LISTENER_OUTBOX_GROUPS = ['CLIPS', 'FOLLOW_UPS', 'CLIENT_ERROR_REPORTS'] as const;
export type ListenerOutboxGroup = (typeof LISTENER_OUTBOX_GROUPS)[number];
export const LISTENER_OUTBOX_GROUP_OF_KIND: Readonly<Record<ListenerOutboxItemKind, ListenerOutboxGroup>> = {
  DEFERRED_CLIP: 'CLIPS',
  STATION_CHOICE: 'FOLLOW_UPS',
  ENGAGEMENT: 'FOLLOW_UPS',
  RECOGNITION_REPORT: 'FOLLOW_UPS',
  CLIENT_ERROR_REPORT: 'CLIENT_ERROR_REPORTS',
};

/**
 * The numbers of contract §3, under the names `timing-rules.json` gives them.
 * - Limits on the phone: 5 clips, each deleted unsent 24 hours after capture; 200 follow-ups, each
 *   deleted 7 days after it was queued; 20 crash reports.
 * - A run waits a random 0 to 120 seconds once (0 to 10 when an item is queued after the last run
 *   emptied the queue). A Retry-After is honoured exactly, clamped to 1 to 3,600 seconds.
 * - Without one, the n-th failure of an item waits min(30 × 2^(n−1), 1800) seconds × a random factor
 *   from 0.5 to 1. A deferred clip shed by the server waits a random 60 to 300 seconds.
 * - A refused token leads to one registration per run. The server allows 10 deferred clips an hour per
 *   install, and waits 2.5 seconds for a live clip's result and 5 seconds for a deferred one's.
 */
export const LISTENER_OUTBOX_TIMING_RULES = {
  maximum_stored_clips: 5,
  stored_clip_lifetime_seconds: 86_400,
  follow_up_item_lifetime_seconds: 604_800,
  maximum_follow_up_items: 200,
  maximum_queued_client_error_reports: 20,
  sending_delay_maximum_seconds: 120,
  sending_delay_for_new_item_while_online_maximum_seconds: 10,
  deferred_shed_retry_after_minimum_seconds: 60,
  deferred_shed_retry_after_maximum_seconds: 300,
  longest_honoured_retry_after_seconds: 3_600,
  backoff_first_wait_seconds: 30,
  backoff_longest_wait_seconds: 1_800,
  backoff_lowest_jitter_factor: 0.5,
  registrations_after_refused_token_per_run: 1,
  deferred_allowance_per_hour: 10,
  live_server_wait_milliseconds: 2_500,
  deferred_server_wait_milliseconds: 5_000,
} as const satisfies Record<string, number>;
export type ListenerOutboxTimingRules = typeof LISTENER_OUTBOX_TIMING_RULES;

/**
 * What the phone does with an outbox item after an answer (contract §3, R9).
 * - DELETE / DELETE_AND_REPORT: the item is gone; the second also sends a crash report (never one about
 *   a crash report).
 * - REGISTER_AGAIN_AND_RESEND: a refused token; register again with the same install id, at most once
 *   per run, and send the item again.
 * - ITEM_WAITS: keep it; only this item waits (a 409 asks for its Retry-After, 3 seconds by default).
 * - ITEM_BACKS_OFF: keep it, count a failure, and only this item waits the backoff.
 * - PAUSE_GROUP: keep it, and pause the item's whole group for the wait.
 * - PAUSE_ALL_UNTIL_APP_VERSION_CHANGES: keep it, and pause every group until the app's version changes,
 *   a live identify gets another answer, or a probe does.
 * - ITEM_BACKS_OFF_AND_RUN_ENDS: no answer; keep it, count a failure, and end the run.
 */
export const LISTENER_OUTBOX_ACKNOWLEDGEMENT_ACTIONS = [
  'DELETE',
  'DELETE_AND_REPORT',
  'REGISTER_AGAIN_AND_RESEND',
  'ITEM_WAITS',
  'ITEM_BACKS_OFF',
  'PAUSE_GROUP',
  'PAUSE_ALL_UNTIL_APP_VERSION_CHANGES',
  'ITEM_BACKS_OFF_AND_RUN_ENDS',
] as const;
export type ListenerOutboxAcknowledgementAction = (typeof LISTENER_OUTBOX_ACKNOWLEDGEMENT_ACTIONS)[number];

/**
 * What the phone got back for an item: an HTTP answer; a 200 whose body the app could not read; no
 * answer at all (no connection, a timeout or a dropped connection); or a fault on the phone itself
 * (for example, the clip's file could not be read).
 */
export const LISTENER_OUTBOX_ANSWER_KINDS = ['HTTP', 'HTTP_WITH_UNREADABLE_BODY', 'NO_ANSWER', 'PHONE_FAULT'] as const;
export type ListenerOutboxAnswerKind = (typeof LISTENER_OUTBOX_ANSWER_KINDS)[number];
