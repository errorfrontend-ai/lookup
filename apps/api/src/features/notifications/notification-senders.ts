import { maskPhoneNumberForDisplay } from '@lookup/contracts';
import { createTransport, type Transporter } from 'nodemailer';
import type { AppConfig } from '../../config/app-config.js';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

export interface OutgoingSms {
  /** E.164. */
  to: string;
  text: string;
  /** The email of the person the SMS is for, when known: what the showcase's stand-in sends it to. */
  standInEmail?: string;
}

export interface EmailSender {
  send(email: OutgoingEmail): Promise<void>;
}

export interface SmsSender {
  send(sms: OutgoingSms): Promise<void>;
}

/** Dependency-injection tokens for the two senders. */
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
export const SMS_SENDER = Symbol('SMS_SENDER');

/**
 * Email over SMTP (nodemailer): Mailpit on this machine in development; in production an smtps:// server, or an
 * smtp:// one that must upgrade to TLS (EMAIL_SMTP_REQUIRE_TLS), the certificate checked either way (P5A design §3.1).
 */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;

  constructor(private readonly config: Pick<AppConfig, 'EMAIL_SMTP_URL' | 'EMAIL_SMTP_REQUIRE_TLS' | 'EMAIL_FROM_ADDRESS'>) {
    const address = new URL(config.EMAIL_SMTP_URL);
    const isImplicitTls = address.protocol === 'smtps:';
    this.transport = createTransport({
      host: address.hostname,
      port: Number(address.port) || (isImplicitTls ? 465 : 25),
      secure: isImplicitTls,
      requireTLS: config.EMAIL_SMTP_REQUIRE_TLS,
      auth: address.username ? { user: decodeURIComponent(address.username), pass: decodeURIComponent(address.password) } : undefined,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(email: OutgoingEmail): Promise<void> {
    await this.transport.sendMail({ from: this.config.EMAIL_FROM_ADDRESS, to: email.to, subject: email.subject, text: email.text });
  }

  close(): void {
    this.transport.close();
  }
}

/**
 * Development only (production refuses it): an SMS arrives as an email in the development inbox, addressed by the
 * number's digits so a browser test can find it, its subject showing the number as the portal does (P5A-D10).
 */
export class DevelopmentSmsSender implements SmsSender {
  constructor(private readonly emailSender: EmailSender) {}

  async send(sms: OutgoingSms): Promise<void> {
    await this.emailSender.send({
      to: developmentSmsInboxAddress(sms.to),
      subject: `SMS to ${maskPhoneNumberForDisplay(sms.to)}`,
      text: sms.text,
    });
  }
}

/** The development inbox's address for a phone number's SMS. */
export function developmentSmsInboxAddress(phoneNumberE164: string): string {
  return `${phoneNumberE164.replace(/^\+/, '')}@sms.development.invalid`;
}

/**
 * The showcase's stand-in until an SMS provider is chosen (ADR-004; the user's choice of 15 October 2026): each SMS
 * is emailed, plainly marked, to the person it is for. A message with no email to go to is not sent at all, so it is
 * tried again and then given up, never delivered to someone else.
 */
export class EmailStandInSmsSender implements SmsSender {
  constructor(private readonly emailSender: EmailSender) {}

  async send(sms: OutgoingSms): Promise<void> {
    if (!sms.standInEmail) throw new Error('no email to send this SMS to (SMS_SENDER=email-stand-in)');
    await this.emailSender.send({
      to: sms.standInEmail,
      subject: STAND_IN_SMS_SUBJECT,
      text: `Look Up sends this by email for now. Later it will come as a text message to ${maskPhoneNumberForDisplay(sms.to)}.\n\n${sms.text}`,
    });
  }
}

export const STAND_IN_SMS_SUBJECT = 'Your Look Up text message (sent by email for now)';

/** SMS_SENDER=none: nothing can be sent, and sign-up stays closed before it gets this far. */
export class ClosedSmsSender implements SmsSender {
  async send(): Promise<void> {
    throw new Error('no SMS sender is configured (SMS_SENDER=none)');
  }
}
