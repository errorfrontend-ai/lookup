import { Injectable } from '@nestjs/common';
import type { InstallRegistration, RegisterInstallInput } from '@lookup/contracts';
import { AppError } from '../../common/errors/app-error.js';
import { InstallTokens } from '../../common/listener-authentication/install-tokens.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';

/**
 * Registers an app install, or recognises one registered before (the same install id), and gives it
 * a fresh install token. Only the keyed hash of the install id is stored; the platform is kept from
 * the first registration, the app version and last-seen time are updated each time.
 */
@Injectable()
export class ListenerInstallsService {
  constructor(
    private readonly installTokens: InstallTokens,
    private readonly stationScopedTransaction: StationScopedTransaction,
  ) {}

  async register(input: RegisterInstallInput): Promise<InstallRegistration> {
    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query(
        `INSERT INTO app.listener_installs (install_id_hash, platform, app_version, last_seen_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (install_id_hash) DO UPDATE SET app_version = EXCLUDED.app_version, last_seen_at = now()
         RETURNING id, status`,
        [this.installTokens.hashInstallId(input.install_id), input.platform, input.app_version],
      ),
    )) as Array<{ id: string; status: string }>;
    const install = rows[0];
    if (!install || install.status !== 'ACTIVE') {
      throw new AppError('FORBIDDEN', {
        publicMessage: "This app can't be used to identify ads.",
        internalDetail: `registration of an install that is ${install?.status ?? 'missing'}`,
      });
    }
    const { installToken, expiresAt } = await this.installTokens.issue(install.id);
    return { install_token: installToken, expires_at: expiresAt.toISOString() };
  }
}
