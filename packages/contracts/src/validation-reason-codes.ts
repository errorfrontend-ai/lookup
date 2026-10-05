import { ACTION_CARD_RULE_REASONS } from './action-card/action-card-schema.js';

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
]);
