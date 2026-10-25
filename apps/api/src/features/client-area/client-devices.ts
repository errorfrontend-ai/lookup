import { createHash } from 'node:crypto';
import type { PushSubscriptionInput, PushSubscriptionRemovalInput, TestNotificationResult } from '@lookup/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import { NotificationQueue } from '../notifications/notification-queue.js';
import { PUSH_SENDER, type PushSender } from '../notifications/web-push.js';
import { ClientArea } from './client-area.service.js';

/** The key a device is found by: its push address's SHA-256 (the address itself is stored only to send to). */
export function endpointHashOf(endpoint: string): Buffer {
  return createHash('sha256').update(endpoint).digest();
}

/**
 * A client's own devices (ADR-006 decision 7; P5C-NOTIFY-01, -03, -06): turning notifications on and off on this device,
 * and a test notification to every device and the email. A device's address and keys go only to the database and to
 * its push service; they are never returned or logged.
 */
@Injectable()
export class ClientDevices {
  constructor(
    private readonly clientArea: ClientArea,
    private readonly notificationQueue: NotificationQueue,
    @Inject(PUSH_SENDER) private readonly pushSender: PushSender,
  ) {}

  async turnOn(input: PushSubscriptionInput): Promise<void> {
    if (this.pushSender.publicKey === null) throw new AppError('PUSH_NOT_AVAILABLE', { internalDetail: 'web push keys are not configured' });
    const [row] = (await this.clientArea.asTheClient((database) =>
      database.query('SELECT app.save_web_push_subscription($1, $2, $3, $4) AS outcome', [input.endpoint, endpointHashOf(input.endpoint), input.keys.p256dh, input.keys.auth]),
    )) as Array<{ outcome: string }>;
    if (row?.outcome !== 'SAVED') throw new AppError('NOT_FOUND', { internalDetail: `device not saved: ${row?.outcome ?? 'no answer'}` });
  }

  /** This device turned off: its subscription goes. Turning off a device that was never on changes nothing. */
  async turnOff(input: PushSubscriptionRemovalInput): Promise<void> {
    await this.clientArea.asTheClient((database) => database.query('SELECT app.delete_own_web_push_subscription($1)', [endpointHashOf(input.endpoint)]));
  }

  /** "Send a test notification": one notice to each of the person's devices when push is on, and the email when that is on. */
  async sendTest(requestId: string, userId: string): Promise<TestNotificationResult> {
    const { settings, devices, email } = await this.clientArea.asTheClient(async (database) => {
      const [access] = (await database.query('SELECT 1 FROM app.list_client_viewer_accesses() LIMIT 1')) as unknown[];
      if (!access) throw new AppError('NOT_FOUND', { internalDetail: 'not a client viewer' });
      const [settingsRow] = (await database.query('SELECT is_push_on, is_email_on FROM app.read_client_viewer_notification_settings()')) as Array<{ is_push_on: boolean; is_email_on: boolean }>;
      const [deviceRow] = (await database.query('SELECT count(*)::int AS devices FROM app.list_own_web_push_subscriptions()')) as Array<{ devices: number }>;
      const [person] = (await database.query('SELECT email FROM app.portal_users WHERE id = app.current_user_id()')) as Array<{ email: string }>;
      return { settings: settingsRow, devices: deviceRow?.devices ?? 0, email: person?.email ?? null };
    });
    if (!settings) throw new AppError('NOT_FOUND', { internalDetail: 'not a client viewer' });
    const pushDevices = settings.is_push_on && this.pushSender.publicKey !== null ? devices : 0;
    if (pushDevices > 0) await this.notificationQueue.enqueue('push', userId, { template: 'test_notification' }, requestId);
    const isEmailSent = settings.is_email_on && email !== null;
    if (isEmailSent) await this.notificationQueue.enqueue('email', email, { template: 'test_notification' }, requestId);
    return { devices: pushDevices, isEmailSent };
  }
}
