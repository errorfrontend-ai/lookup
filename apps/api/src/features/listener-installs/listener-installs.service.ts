import { Injectable } from '@nestjs/common';
import type { InstallRegistration, RegisterInstallInput } from '@lookup/contracts';
import { AppError } from '../../common/errors/app-error.js';
import { InstallTokens, readBearerInstallToken } from '../../common/listener-authentication/install-tokens.js';
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

  /**
   * The install's row id when `authorizationHeader` carries a valid install token of an ACTIVE install whose stored
   * hash is that of `installId`: the phone registering again (A3). Null for anything else (no header, an expired or
   * bad token, another install's token, a blocked install), which is a first registration.
   */
  async findReregisteringInstall(authorizationHeader: string | undefined, installId: string): Promise<string | null> {
    const token = readBearerInstallToken(authorizationHeader);
    const listenerInstallId = token ? await this.installTokens.verify(token) : null;
    if (!listenerInstallId) return null;
    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query(`SELECT id FROM app.listener_installs WHERE id = $1 AND install_id_hash = $2 AND status = 'ACTIVE'`, [
        listenerInstallId,
        this.installTokens.hashInstallId(installId),
      ]),
    )) as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  }

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
