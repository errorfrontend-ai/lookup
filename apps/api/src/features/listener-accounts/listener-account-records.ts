import { Injectable } from '@nestjs/common';
import type { ListenerGender } from '@lookup/contracts';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';

export type LinkInstallOutcome = 'LINKED' | 'ALREADY_LINKED' | 'NO_ACCOUNT' | 'NO_INSTALL' | 'LINKED_TO_ANOTHER_ACCOUNT';
export type CreateAccountOutcome = 'CREATED' | 'LINKED_EXISTING' | 'ALREADY_LINKED' | 'LINKED_TO_ANOTHER_ACCOUNT' | 'NO_INSTALL';

export interface DescribedAccount {
  listenerAccountId: string;
  emailSealed: Buffer;
}

/**
 * The account functions in the database (migration ListenerAccounts). They are the API's only way to touch the accounts
 * table, which its login can neither read nor write, and each returns only what its caller needs.
 */
@Injectable()
export class ListenerAccountRecords {
  constructor(private readonly stationScopedTransaction: StationScopedTransaction) {}

  /** Signing in: the install joins the account that already holds this email's hash. */
  async linkInstallToExistingAccount(listenerInstallId: string, emailHash: Buffer): Promise<LinkInstallOutcome> {
    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT app.link_listener_install_to_existing_account($1, $2) AS outcome', [listenerInstallId, emailHash]),
    )) as Array<{ outcome: LinkInstallOutcome }>;
    return rows[0]?.outcome ?? 'NO_INSTALL';
  }

  /** Creating the account after a right code for a new email, and linking the install to it. */
  async createAccountAndLinkInstall(input: {
    accountId: string;
    listenerInstallId: string;
    emailHash: Buffer;
    emailSealed: Buffer;
    gender: ListenerGender;
    birthYear: number;
    consentTextVersion: string;
    requestId: string;
  }): Promise<CreateAccountOutcome> {
    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT app.create_listener_account_and_link_install($1, $2, $3, $4, $5, $6::smallint, $7, $8) AS outcome', [
        input.accountId,
        input.listenerInstallId,
        input.emailHash,
        input.emailSealed,
        input.gender,
        input.birthYear,
        input.consentTextVersion,
        input.requestId,
      ]),
    )) as Array<{ outcome: CreateAccountOutcome }>;
    return rows[0]?.outcome ?? 'NO_INSTALL';
  }

  async unlinkInstall(listenerInstallId: string): Promise<'UNLINKED' | 'NOT_LINKED'> {
    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT app.unlink_listener_install_from_account($1) AS outcome', [listenerInstallId]),
    )) as Array<{ outcome: 'UNLINKED' | 'NOT_LINKED' }>;
    return rows[0]?.outcome ?? 'NOT_LINKED';
  }

  async deleteAccountOfInstall(listenerInstallId: string, requestId: string): Promise<'DELETED' | 'NO_ACCOUNT'> {
    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT app.delete_listener_account_of_install($1, $2) AS outcome', [listenerInstallId, requestId]),
    )) as Array<{ outcome: 'DELETED' | 'NO_ACCOUNT' }>;
    return rows[0]?.outcome ?? 'NO_ACCOUNT';
  }

  /** The account the install belongs to, or null when it has none. */
  async describeAccountOfInstall(listenerInstallId: string): Promise<DescribedAccount | null> {
    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT * FROM app.describe_listener_account_of_install($1)', [listenerInstallId]),
    )) as Array<{ listener_account_id: string; email_sealed: Buffer }>;
    const row = rows[0];
    return row ? { listenerAccountId: row.listener_account_id, emailSealed: row.email_sealed } : null;
  }
}
