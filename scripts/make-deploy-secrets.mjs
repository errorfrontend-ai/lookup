// Prints new random secrets for a deploy, as KEY=value lines to paste into Render ("Add from .env") when the
// Blueprint asks for them:   npm run deploy:new-secrets
// Each is 32 random bytes in base64url (the API refuses anything shorter or with other characters). They are made
// on this computer and shown once: paste them into Render, then clear the terminal. Never commit them.
import { randomBytes } from 'node:crypto';

const names = ['AUTHENTICATION_SECRET', 'TWO_FACTOR_ENCRYPTION_SECRET', 'LISTENER_INSTALL_TOKEN_SECRET', 'LISTENER_INSTALL_ID_PEPPER'];
for (const name of names) console.log(`${name}=${randomBytes(32).toString('base64url')}`);
