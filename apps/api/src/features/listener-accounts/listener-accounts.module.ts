import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { ListenerAccountRecords } from './listener-account-records.js';
import { ListenerAccountTickets } from './listener-account-tickets.js';
import { ListenerAccountsController } from './listener-accounts.controller.js';
import { ListenerAccountsService } from './listener-accounts.service.js';
import { ListenerEmailBox } from './listener-email-box.js';
import { ListenerEmailCodes } from './listener-email-codes.js';

/** Listener accounts: an email proved by a code, a gender and an age (ADR-005). */
@Module({
  controllers: [ListenerAccountsController],
  providers: [
    ListenerAccountsService,
    ListenerAccountRecords,
    ListenerEmailCodes,
    ListenerAccountTickets,
    { provide: ListenerEmailBox, inject: [APP_CONFIG], useFactory: (config: AppConfig) => new ListenerEmailBox(config.LISTENER_EMAIL_ENCRYPTION_SECRET) },
  ],
})
export class ListenerAccountsModule {}
