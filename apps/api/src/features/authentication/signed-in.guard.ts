import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import type { DataSource } from 'typeorm';
import { AppError } from '../../common/errors/app-error.js';
import { DerivedKeys } from '../../common/security/derived-keys.js';
import { AccessTokens } from './access-tokens.js';
import { PUBLIC_ROUTE_METADATA } from './public-route.decorator.js';
import { ACCESS_TOKEN_COOKIE } from './session-cookies.js';

/**
 * Runs on every request (registered globally). A route marked @PublicRoute() passes; any other needs a
 * valid access token whose session row is still live and whose user is still active. The user and
 * session ids then go into the request context, where StationScopedTransaction picks them up, and a
 * keyed hash of the user id goes on every log line of the request as `actor` (never the raw id or
 * the email), so one person's requests can be followed through the log.
 */
@Injectable()
export class SignedInGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokens,
    private readonly requestContext: ClsService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly derivedKeys: DerivedKeys,
    private readonly logger: PinoLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublicRoute = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublicRoute || context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<Request>();
    const accessToken: unknown = request.cookies?.[ACCESS_TOKEN_COOKIE];
    const claims = typeof accessToken === 'string' ? await this.accessTokens.verify(accessToken) : null;
    if (!claims) throw new AppError('UNAUTHENTICATED', { internalDetail: 'missing or invalid access token' });

    const rows = (await this.dataSource.query('SELECT app.find_active_portal_session($1) AS session_owner_id', [
      claims.portalSessionId,
    ])) as Array<{ session_owner_id: string | null }>;
    if (rows[0]?.session_owner_id !== claims.portalUserId) {
      throw new AppError('UNAUTHENTICATED', { internalDetail: 'session ended, expired, or user disabled' });
    }
    this.requestContext.set('userId', claims.portalUserId);
    this.requestContext.set('sessionId', claims.portalSessionId);
    this.logger.assign({ actor: this.derivedKeys.hashIdentifier(claims.portalUserId) });
    return true;
  }
}
