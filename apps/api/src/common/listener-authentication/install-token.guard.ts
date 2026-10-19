import { isBelowMinimumAppVersion } from '@lookup/contracts';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { AppError } from '../errors/app-error.js';
import { DerivedKeys } from '../security/derived-keys.js';
import { InstallTokens, readBearerInstallToken } from './install-tokens.js';

/** Request-context key holding the listener install a request comes from. */
export const LISTENER_INSTALL_ID = 'listenerInstallId';

/**
 * Request-context key holding the keyed hash of that install: the `actor` of the request's log lines, and the only
 * form in which a report keeps the listener (P4-D26, P4-D28). Never the raw id.
 */
export const LISTENER_INSTALL_HASH = 'listenerInstallHash';

/**
 * Request-context key holding the listener account the install belongs to, or null when it has none (ADR-005). The
 * recognition routes hold back an ad's result from an install with no account while LISTENER_ACCOUNT_REQUIRED is on.
 * Only the account's id is kept here: it is a stand-in, not the person.
 */
export const LISTENER_ACCOUNT_ID = 'listenerAccountId';

/**
 * The listener routes' check: a valid install token in `Authorization: Bearer …` for an install that
 * is not blocked. Anything else is 401 INSTALL_TOKEN_INVALID, before any other work (S3-REQUEST-16),
 * and the app registers again. Then the update gate: an install registered with an app version below
 * LISTENER_MINIMUM_APP_VERSION gets 426 APP_UPDATE_REQUIRED on every route this guard covers (P4 design
 * §5.7); registering again with a newer app clears it at once. The install's id goes into the request
 * context, and a keyed hash of it on every log line of the request as `actor`.
 */
@Injectable()
export class InstallTokenGuard implements CanActivate {
  constructor(
    private readonly installTokens: InstallTokens,
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly requestContext: ClsService,
    private readonly derivedKeys: DerivedKeys,
    private readonly logger: PinoLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = readBearerInstallToken(request.headers.authorization);
    const listenerInstallId = token ? await this.installTokens.verify(token) : null;
    if (!listenerInstallId) throw new AppError('INSTALL_TOKEN_INVALID', { internalDetail: token ? 'install token not valid' : 'no install token' });

    // From here every line of the request, its error lines included, says which install it was, by a keyed hash.
    const listenerInstallHash = this.derivedKeys.hashIdentifier(listenerInstallId);
    this.logger.assign({ actor: listenerInstallHash });

    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query(`SELECT status, app_version, listener_account_id FROM app.listener_installs WHERE id = $1`, [listenerInstallId]),
    )) as Array<{ status: string; app_version: string; listener_account_id: string | null }>;
    const install = rows[0];
    if (install?.status !== 'ACTIVE') {
      throw new AppError('INSTALL_TOKEN_INVALID', { internalDetail: install ? `install is ${install.status}` : 'install not found' });
    }
    if (isBelowMinimumAppVersion(install.app_version, this.config.LISTENER_MINIMUM_APP_VERSION)) {
      throw new AppError('APP_UPDATE_REQUIRED', { internalDetail: `install registered app version below the minimum ${this.config.LISTENER_MINIMUM_APP_VERSION}` });
    }
    this.requestContext.set(LISTENER_INSTALL_ID, listenerInstallId);
    this.requestContext.set(LISTENER_INSTALL_HASH, listenerInstallHash);
    this.requestContext.set(LISTENER_ACCOUNT_ID, install.listener_account_id);
    return true;
  }
}
