import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { AppError } from '../errors/app-error.js';
import { InstallTokens } from './install-tokens.js';

/** Request-context key holding the listener install a request comes from. */
export const LISTENER_INSTALL_ID = 'listenerInstallId';

/**
 * The listener routes' check: a valid install token in `Authorization: Bearer …` for an install that
 * is not blocked. Anything else is 401 INSTALL_TOKEN_INVALID, before any other work (S3-REQUEST-16),
 * and the app registers again. The install's id goes into the request context.
 */
@Injectable()
export class InstallTokenGuard implements CanActivate {
  constructor(
    private readonly installTokens: InstallTokens,
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly requestContext: ClsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization ?? '';
    const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header)?.[1];
    const listenerInstallId = token ? await this.installTokens.verify(token) : null;
    if (!listenerInstallId) throw new AppError('INSTALL_TOKEN_INVALID', { internalDetail: token ? 'install token not valid' : 'no install token' });

    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query(`SELECT status FROM app.listener_installs WHERE id = $1`, [listenerInstallId]),
    )) as Array<{ status: string }>;
    if (rows[0]?.status !== 'ACTIVE') {
      throw new AppError('INSTALL_TOKEN_INVALID', { internalDetail: rows[0] ? `install is ${rows[0].status}` : 'install not found' });
    }
    this.requestContext.set(LISTENER_INSTALL_ID, listenerInstallId);
    return true;
  }
}
