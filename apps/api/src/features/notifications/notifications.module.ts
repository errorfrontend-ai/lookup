import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { NotificationQueue } from './notification-queue.js';
import { ClosedSmsSender, DevelopmentSmsSender, EMAIL_SENDER, EmailStandInSmsSender, SMS_SENDER, type SmsSender, SmtpEmailSender, type EmailSender } from './notification-senders.js';
import { NotificationWorker } from './notification-worker.js';

/**
 * SMS and email (P5A design §3.1, §3.6; P5A-STRUCTURE-04): features queue a message with NotificationQueue; the
 * worker in this process sends it with the configured senders.
 */
@Global()
@Module({
  providers: [
    NotificationQueue,
    NotificationWorker,
    { provide: EMAIL_SENDER, inject: [APP_CONFIG], useFactory: (config: AppConfig) => new SmtpEmailSender(config) },
    {
      provide: SMS_SENDER,
      inject: [APP_CONFIG, EMAIL_SENDER],
      useFactory: (config: AppConfig, emailSender: EmailSender): SmsSender => {
        if (config.SMS_SENDER === 'development') return new DevelopmentSmsSender(emailSender);
        if (config.SMS_SENDER === 'email-stand-in') return new EmailStandInSmsSender(emailSender);
        return new ClosedSmsSender();
      },
    },
  ],
  exports: [NotificationQueue],
})
export class NotificationsModule implements OnApplicationShutdown {
  constructor(@Inject(EMAIL_SENDER) private readonly emailSender: EmailSender) {}

  onApplicationShutdown(): void {
    if (this.emailSender instanceof SmtpEmailSender) this.emailSender.close();
  }
}
