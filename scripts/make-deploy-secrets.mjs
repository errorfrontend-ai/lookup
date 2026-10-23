// Prints new random secrets for a deploy, as KEY=value lines to paste into Render ("Add from .env"):
//   npm run deploy:new-secrets                                            all five, for the first deploy
//   npm run deploy:new-secrets -- LISTENER_EMAIL_ENCRYPTION_SECRET        only the ones named, for a site already running
// Each is 32 random bytes in base64url (the API refuses anything shorter or with other characters). They are made
// on this computer and shown once: paste them into Render, then clear the terminal. Never commit them.
//
// On a site that is already running, never replace a secret it already has: a new AUTHENTICATION_SECRET signs everyone
// out, a new LISTENER_INSTALL_ID_PEPPER or LISTENER_INSTALL_TOKEN_SECRET makes every phone register again, a new
// TWO_FACTOR_ENCRYPTION_SECRET makes the super admins' sign-in codes unreadable, and a new
// LISTENER_EMAIL_ENCRYPTION_SECRET makes every listener's email unreadable. Name only the secret a release adds.
import { randomBytes } from 'node:crypto';

export const SECRET_NAMES = ['AUTHENTICATION_SECRET', 'TWO_FACTOR_ENCRYPTION_SECRET', 'LISTENER_INSTALL_TOKEN_SECRET', 'LISTENER_INSTALL_ID_PEPPER', 'LISTENER_EMAIL_ENCRYPTION_SECRET'];

const asked = process.argv.slice(2);
const unknown = asked.filter((name) => !SECRET_NAMES.includes(name));
if (unknown.length > 0) {
  console.error(`Not a deploy secret: ${unknown.join(', ')}. The secrets are: ${SECRET_NAMES.join(', ')}.`);
  process.exit(1);
}
for (const name of asked.length > 0 ? asked : SECRET_NAMES) console.log(`${name}=${randomBytes(32).toString('base64url')}`);
if (asked.length === 0) {
  console.error('\nThese are for a FIRST deploy. On a site already running, paste only a secret it does not have yet,');
  console.error('for example: npm run deploy:new-secrets -- LISTENER_EMAIL_ENCRYPTION_SECRET');
}
