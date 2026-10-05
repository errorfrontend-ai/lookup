import type { StationRole, StationStatus } from '@lookup/contracts';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { AppError } from '../../common/errors/app-error.js';
import { DerivedKeys } from '../../common/security/derived-keys.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { READ_STATION_CONTENT, STATION_ACCESS_METADATA, type StationAccessRequirement } from './station-access.decorator.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guards every route under /stations/{stationId}. The signed-in user must be a member of that station;
 * otherwise the answer is 404, exactly as for a station that doesn't exist, so station ids can't be
 * probed. Then the route's requirement applies: the station must be ACTIVE for its content, and only
 * the allowed roles get through (403). The station and role go into the request context, where
 * StationScopedTransaction and row-level security take over.
 */
@Injectable()
export class StationAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly requestContext: ClsService,
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly derivedKeys: DerivedKeys,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement =
      this.reflector.getAllAndOverride<StationAccessRequirement | undefined>(STATION_ACCESS_METADATA, [
        context.getHandler(),
        context.getClass(),
      ]) ?? READ_STATION_CONTENT;
    const stationId = context.switchToHttp().getRequest<Request>().params.stationId;
    if (typeof stationId !== 'string' || !UUID_PATTERN.test(stationId)) {
      throw new AppError('NOT_FOUND', { internalDetail: 'station id is not a UUID' });
    }

    const userId = this.requestContext.get<string>('userId');
    const [membership] = await this.stationScopedTransaction.run(
      (database) =>
        database.query(
          `SELECT memberships.role, stations.status
             FROM app.station_memberships AS memberships
             JOIN app.stations AS stations ON stations.id = memberships.station_id
            WHERE memberships.station_id = $1 AND memberships.portal_user_id = app.current_user_id()`,
          [stationId],
        ) as Promise<Array<{ role: StationRole; status: StationStatus }>>,
      { userId, stationId: '' },
    );
    if (!membership) {
      throw new AppError('NOT_FOUND', {
        internalDetail: `not a member of station ${this.derivedKeys.hashIdentifier(stationId.toLowerCase())}`,
      });
    }
    if (requirement.requiresActiveStation && membership.status !== 'ACTIVE') {
      throw new AppError('STATION_NOT_ACTIVE', { internalDetail: `station status ${membership.status}` });
    }
    if (!requirement.allowedRoles.includes(membership.role)) {
      throw new AppError('FORBIDDEN', { internalDetail: `role ${membership.role} may not do this` });
    }
    this.requestContext.set('stationId', stationId.toLowerCase());
    this.requestContext.set('stationRole', membership.role);
    return true;
  }
}
