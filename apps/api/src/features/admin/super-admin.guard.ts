import { type CanActivate, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AppError } from '../../common/errors/app-error.js';

/**
 * Every admin route (P5A design §3.3; P5A-ADMIN-ACCESS-01, -04): the signed-in user is a SUPER_ADMIN and this session
 * has passed the second factor. A super admin without it gets TWO_FACTOR_REQUIRED; anyone else gets 404, as if the
 * console did not exist. SUPPORT has no access (P5A-D12). The signed-in guard has already set both facts.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(private readonly requestContext: ClsService) {}

  canActivate(): boolean {
    if (this.requestContext.get<string | null | undefined>('platformRole') !== 'SUPER_ADMIN') {
      throw new AppError('NOT_FOUND', { internalDetail: 'not a super admin' });
    }
    if (this.requestContext.get<boolean | undefined>('isTwoFactorVerified') !== true) {
      throw new AppError('TWO_FACTOR_REQUIRED', { internalDetail: 'the session has not passed the second factor' });
    }
    return true;
  }
}
