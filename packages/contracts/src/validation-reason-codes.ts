import type { z } from 'zod';
import { ACTION_CARD_RULE_REASONS } from './action-card/action-card-schema.js';
import { SCHEDULE_RULE_REASONS } from './ads/schedule-schemas.js';

/** Why a password was refused (NIST SP 800-63B rev 4 requires telling the person why). */
export const PASSWORD_POLICY_REASONS = ['too_short', 'too_long', 'too_common', 'contains_personal_details'] as const;
export type PasswordPolicyReason = (typeof PASSWORD_POLICY_REASONS)[number];

/**
 * Reason codes the API may relay in a VALIDATION_FAILED response. They are fixed strings written
 * here, never user input or library text, so they are safe to show. Any other custom validation
 * issue is reported only as the generic code "custom".
 */
export const VALIDATION_REASON_CODES: ReadonlySet<string> = new Set<string>([
  ...ACTION_CARD_RULE_REASONS,
  ...PASSWORD_POLICY_REASONS,
  ...SCHEDULE_RULE_REASONS,
]);

/**
 * The reason code to show for one validation problem: zod's own code, or for one of our rules its
 * fixed reason when it is in VALIDATION_REASON_CODES, otherwise "custom". The API and the portal's
 * own checks both use this, so a problem has the same code in both places.
 */
export function reasonCodeForIssue(issue: z.core.$ZodIssue): string {
  if (issue.code !== 'custom') return issue.code;
  const reason = (issue as { params?: { reason?: unknown } }).params?.reason;
  return typeof reason === 'string' && VALIDATION_REASON_CODES.has(reason) ? reason : 'custom';
}
