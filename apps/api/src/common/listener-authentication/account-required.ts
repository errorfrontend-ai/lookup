import type { ClsService } from 'nestjs-cls';
import type { AppConfig } from '../../config/app-config.js';
import { LISTENER_ACCOUNT_ID } from './install-token.guard.js';

/**
 * Whether the request comes from an install with no listener account while accounts are required (ADR-005,
 * LISTENER_ACCOUNT_REQUIRED). The recognition routes hold an ad's result back then, and the routes whose answers would
 * tell such an install which stations own a withheld recording (a station choice, a report) answer like an unknown
 * recognition (LA-GATE-08). Read from the request context the install-token guard filled.
 */
export function isAccountRequiredAndMissing(config: Pick<AppConfig, 'LISTENER_ACCOUNT_REQUIRED'>, requestContext: ClsService): boolean {
  return config.LISTENER_ACCOUNT_REQUIRED && !requestContext.get<string | null | undefined>(LISTENER_ACCOUNT_ID);
}
