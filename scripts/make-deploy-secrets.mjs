// Prints new random secrets for a deploy, as KEY=value lines to paste into Render ("Add from .env"):
//   npm run deploy:new-secrets                                            all five, for the first deploy
//   npm run deploy:new-secrets -- LISTENER_EMAIL_ENCRYPTION_SECRET        only the ones named, for a site already running
//   npm run deploy:new-secrets -- WEB_PUSH_KEYS                           the push key pair for clients' reminders (optional)
// Each is 32 random bytes in base64url (the API refuses anything shorter or with other characters). They are made
// on this computer and shown once: paste them into Render, then clear the terminal. Never commit them.
//
// On a site that is already running, never replace a secret it already has: a new AUTHENTICATION_SECRET signs everyone
// out, a new LISTENER_INSTALL_ID_PEPPER or LISTENER_INSTALL_TOKEN_SECRET makes every phone register again, a new
// TWO_FACTOR_ENCRYPTION_SECRET makes the super admins' sign-in codes unreadable, and a new
// LISTENER_EMAIL_ENCRYPTION_SECRET makes every listener's email unreadable, and new WEB_PUSH_KEYS make every client turn
// notifications on again on each device. Name only the secret a release adds.
//
// WEB_PUSH_KEYS is a pair (ADR-006): WEB_PUSH_PUBLIC_KEY and WEB_PUSH_PRIVATE_KEY, a P-256 key pair in base64url. Add
// WEB_PUSH_CONTACT_EMAIL beside them by hand: the address push services may write to about this server.
import { createECDH, randomBytes } from 'node:crypto';

export const SECRET_NAMES = ['AUTHENTICATION_SECRET', 'TWO_FACTOR_ENCRYPTION_SECRET', 'LISTENER_INSTALL_TOKEN_SECRET', 'LISTENER_INSTALL_ID_PEPPER', 'LISTENER_EMAIL_ENCRYPTION_SECRET'];
/** Secrets made only when named: a feature that works without them until they are added. */
export const OPTIONAL_SECRET_NAMES = ['WEB_PUSH_KEYS'];

const asked = process.argv.slice(2);
const unknown = asked.filter((name) => !SECRET_NAMES.includes(name) && !OPTIONAL_SECRET_NAMES.includes(name));
if (unknown.length > 0) {
  console.error(`Not a deploy secret: ${unknown.join(', ')}. The secrets are: ${[...SECRET_NAMES, ...OPTIONAL_SECRET_NAMES].join(', ')}.`);
  process.exit(1);
}
for (const name of asked.length > 0 ? asked : SECRET_NAMES) {
  if (name === 'WEB_PUSH_KEYS') {
    const keys = createECDH('prime256v1');
    keys.generateKeys();
    console.log(`WEB_PUSH_PUBLIC_KEY=${keys.getPublicKey().toString('base64url')}`);
    console.log(`WEB_PUSH_PRIVATE_KEY=${keys.getPrivateKey().toString('base64url')}`);
    console.error('Add WEB_PUSH_CONTACT_EMAIL=<an address you read> beside them: push services may write to it about this server.');
  } else {
    console.log(`${name}=${randomBytes(32).toString('base64url')}`);
  }
}
if (asked.length === 0) {
  console.error('\nThese are for a FIRST deploy. On a site already running, paste only a secret it does not have yet,');
  console.error('for example: npm run deploy:new-secrets -- LISTENER_EMAIL_ENCRYPTION_SECRET');
}
