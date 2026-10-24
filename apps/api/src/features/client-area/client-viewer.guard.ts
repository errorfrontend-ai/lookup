import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../../common/errors/app-error.js';
import { DerivedKeys } from '../../common/security/derived-keys.js';
import { ClientArea } from './client-area.service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guards the client routes that name a station (ADR-006): the signed-in person must follow a client there, at an ACTIVE
 * station; otherwise the answer is 404, exactly as for a station that does not exist, so station ids cannot be probed.
 * The database functions check the same again for each advert.
 */
@Injectable()
export class ClientViewerGuard implements CanActivate {
  constructor(
    private readonly clientArea: ClientArea,
    private readonly derivedKeys: DerivedKeys,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const stationId = context.switchToHttp().getRequest<Request>().params.stationId;
    if (stationId === undefined) return true;
    if (typeof stationId !== 'string' || !UUID_PATTERN.test(stationId)) {
      throw new AppError('NOT_FOUND', { internalDetail: 'station id is not a UUID' });
    }
    if (!(await this.clientArea.canViewStation(stationId.toLowerCase()))) {
      throw new AppError('NOT_FOUND', { internalDetail: `no client access at station ${this.derivedKeys.hashIdentifier(stationId.toLowerCase())}` });
    }
    return true;
  }
}
