/**
 * The development inbox (Mailpit, in infra/docker-compose.yml): every email the API sends in development lands here,
 * and so does every SMS, as an email to <digits>@sms.development.invalid (DevelopmentSmsSender). The browser tests
 * read codes and links from it through Mailpit's API, so nothing ever leaves this computer.
 */
const MAIL_INBOX_ADDRESS = 'http://127.0.0.1:8025';
const POLL_MILLISECONDS = 500;

export interface InboxMessage {
  id: string;
  subject: string;
  text: string;
}

interface MailpitSearchAnswer {
  messages: Array<{ ID: string; Subject: string }>;
}

/** Where the development SMS sender puts a phone number's texts. */
export function smsInboxAddress(phoneNumberE164: string): string {
  return `${phoneNumberE164.replace(/^\+/, '')}@sms.development.invalid`;
}

async function readJson<T>(path: string): Promise<T> {
  const answer = await fetch(`${MAIL_INBOX_ADDRESS}${path}`);
  if (!answer.ok) throw new Error(`The development inbox answered ${answer.status} to ${path.split('?')[0]}. Is the "mail" service running (docker compose -f infra/docker-compose.yml up -d)?`);
  return (await answer.json()) as T;
}

/**
 * Waits for the newest message to this address whose text matches, ignoring the ones in `alreadyRead`, and returns
 * it. The match is on the text, not the subject, because an SMS has no subject of its own.
 */
export async function waitForMessageTo(
  recipient: string,
  matches: RegExp,
  { alreadyRead = new Set<string>(), timeoutMilliseconds = 30_000 }: { alreadyRead?: Set<string>; timeoutMilliseconds?: number } = {},
): Promise<InboxMessage> {
  const query = encodeURIComponent(`to:"${recipient}"`);
  const giveUpAt = Date.now() + timeoutMilliseconds;
  while (Date.now() < giveUpAt) {
    const found = await readJson<MailpitSearchAnswer>(`/api/v1/search?query=${query}&limit=20`);
    for (const summary of found.messages) {
      if (alreadyRead.has(summary.ID)) continue;
      const message = await readJson<{ Text: string; Subject: string }>(`/api/v1/message/${summary.ID}`);
      if (matches.test(message.Text)) {
        alreadyRead.add(summary.ID);
        // The mail format adds a line ending (and spaces before it) that the message itself never had.
        return { id: summary.ID, subject: message.Subject, text: message.Text.trim() };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MILLISECONDS));
  }
  throw new Error(`No message matching ${String(matches)} reached the development inbox in ${timeoutMilliseconds / 1000} s.`);
}

/** The first match of a pattern's first group in a message, or a clear failure. */
export function pickFrom(message: InboxMessage, pattern: RegExp): string {
  const found = pattern.exec(message.text)?.[1];
  if (!found) throw new Error(`The message "${message.subject}" has nothing matching ${String(pattern)}.`);
  return found;
}
