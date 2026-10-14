import { APPLICATION_REVIEW_TIME_TEXT, PHONE_CODE_LIFETIME_SECONDS } from '@lookup/contracts';

/**
 * Every SMS and email Look Up sends (P5A design §3.6): plain text from named parameters, never HTML. A link is the
 * portal's own address with the token in its fragment, which a browser never sends to a server, so tokens stay out of
 * access logs.
 */
export type NotificationMessage =
  | { template: 'phone_verification_code'; code: string }
  | { template: 'email_verification_link'; linkToken: string; fullName: string }
  | { template: 'application_submitted'; stationName: string }
  | { template: 'application_approved'; stationName: string }
  | { template: 'application_rejected'; stationName: string; reason: string }
  | { template: 'change_request_approved'; stationName: string }
  | { template: 'change_request_rejected'; stationName: string; reason: string }
  | { template: 'station_suspended'; stationName: string; reason: string }
  | { template: 'station_reactivated'; stationName: string }
  | { template: 'team_invitation'; linkToken: string; stationName: string; stationRole: string };

export type NotificationTemplate = NotificationMessage['template'];

export interface EmailText {
  subject: string;
  text: string;
}

const ROLE_WORDS: Record<string, string> = { OWNER: 'an owner', MANAGER: 'a manager', ANALYST: 'an analyst' };

/** The SMS of a message, for the templates that have one. */
export function smsTextOf(message: NotificationMessage, portalOrigin: string): string | null {
  switch (message.template) {
    case 'phone_verification_code':
      // The last line lets Android and iOS offer the code to the portal on its own host (WebOTP, P5A-VERIFICATION-02).
      return `Your Look Up code is ${message.code}. It expires in ${PHONE_CODE_LIFETIME_SECONDS / 60} minutes. Don't share it.\n\n@${new URL(portalOrigin).host} #${message.code}`;
    case 'application_approved':
      return `Look Up: ${message.stationName} is approved. Sign in to upload your first ad.`;
    case 'application_rejected':
      return `Look Up: your application for ${message.stationName} needs changes. Sign in to see why and submit it again.`;
    case 'change_request_approved':
      return `Look Up: the change to ${message.stationName} is approved and now shows to listeners.`;
    case 'change_request_rejected':
      return `Look Up: the change to ${message.stationName} was not approved. Sign in to see why.`;
    case 'station_suspended':
      return `Look Up: ${message.stationName} is suspended. Listeners no longer see its ads. Sign in to see why.`;
    case 'station_reactivated':
      return `Look Up: ${message.stationName} is active again. Listeners see its ads again.`;
    default:
      return null;
  }
}

/** The email of a message, for the templates that have one. */
export function emailTextOf(message: NotificationMessage, portalOrigin: string): EmailText | null {
  const signIn = `Sign in: ${portalOrigin}/sign-in`;
  switch (message.template) {
    case 'email_verification_link':
      return {
        subject: 'Confirm your email for Look Up',
        text: `Hello ${message.fullName},\n\nConfirm this email address for your station's Look Up application:\n\n${portalOrigin}/verify-email#token=${message.linkToken}\n\nThe link works once and lasts 24 hours. If you did not sign up for Look Up, ignore this email.`,
      };
    case 'application_submitted':
      return {
        subject: `Look Up received the application for ${message.stationName}`,
        text: `Thank you. We check every station before it goes live, which takes about ${APPLICATION_REVIEW_TIME_TEXT}. We will email and send an SMS when it is done.\n\n${signIn}`,
      };
    case 'application_approved':
      return {
        subject: `${message.stationName} is approved on Look Up`,
        text: `Your station is approved. You can now upload ads, add their buttons and schedule them.\n\n${signIn}`,
      };
    case 'application_rejected':
      return {
        subject: `Your Look Up application for ${message.stationName} needs changes`,
        text: `We could not approve the application yet. The reviewer wrote:\n\n${message.reason}\n\nSign in, change what is needed, and submit it again.\n\n${signIn}`,
      };
    case 'change_request_approved':
      return {
        subject: `The change to ${message.stationName} is approved`,
        text: `The new details now show to listeners.\n\n${signIn}`,
      };
    case 'change_request_rejected':
      return {
        subject: `The change to ${message.stationName} was not approved`,
        text: `The station keeps its approved details. The reviewer wrote:\n\n${message.reason}\n\n${signIn}`,
      };
    case 'station_suspended':
      return {
        subject: `${message.stationName} is suspended on Look Up`,
        text: `Listeners no longer see this station's ads. The reason:\n\n${message.reason}\n\nReply to this email if you think this is a mistake.\n\n${signIn}`,
      };
    case 'station_reactivated':
      return {
        subject: `${message.stationName} is active again on Look Up`,
        text: `Listeners see this station's ads again.\n\n${signIn}`,
      };
    case 'team_invitation':
      return {
        subject: `You're invited to ${message.stationName} on Look Up`,
        text: `You're invited to join ${message.stationName}'s team on Look Up as ${ROLE_WORDS[message.stationRole] ?? 'a member'}.\n\n${portalOrigin}/invitations/accept#token=${message.linkToken}\n\nThe invitation works once and lasts 7 days.`,
      };
    default:
      return null;
  }
}
