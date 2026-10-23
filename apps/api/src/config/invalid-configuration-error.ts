/**
 * Startup refused because a setting is missing or wrong. Each of [settingProblems] names a setting and what is wrong
 * with it, never its value: the names come from the configuration schema itself, and the reasons are zod's codes or our
 * own messages. The log keeps them in a field of their own, as it keeps a database error's table and column names,
 * because the masking of message text would take a long setting name for a token: on Render's first deploy of listener
 * accounts the log read "Invalid configuration — [token]: invalid_type" where it meant LISTENER_EMAIL_ENCRYPTION_SECRET,
 * which is 32 characters.
 */
export class InvalidConfigurationError extends Error {
  constructor(readonly settingProblems: readonly string[]) {
    super(`Invalid configuration — ${settingProblems.join('; ')}`);
    this.name = 'InvalidConfigurationError';
  }
}
