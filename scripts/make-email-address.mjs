// Builds EMAIL_SMTP_URL for Render from the two things Brevo shows on its SMTP page (SMTP & API → SMTP):
//   npm run deploy:email-address
// It asks for the Login (like 8a12b3001@smtp-brevo.com) and the SMTP key, and prints the finished value to paste into
// Render. Both are encoded for a web address (the @ in the login becomes %40). Nothing is saved or sent anywhere.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const terminal = createInterface({ input: stdin, output: stdout });
const lines = terminal[Symbol.asyncIterator]();
const ask = async (prompt) => {
  stdout.write(prompt);
  const { value } = await lines.next();
  return (value ?? '').trim();
};
const login = await ask('Brevo SMTP Login (looks like 8a12b3001@smtp-brevo.com): ');
const key = await ask('Brevo SMTP key (starts with xsmtpsib-): ');
terminal.close();

if (!login.includes('@') || key.length < 10) {
  console.log('\nThat does not look right: the Login has an @ in it, and the key is a long line starting with xsmtpsib-. Try again.');
  process.exit(1);
}
console.log('\nPaste this into Render as EMAIL_SMTP_URL (then clear this terminal):\n');
console.log(`smtp://${encodeURIComponent(login)}:${encodeURIComponent(key)}@smtp-relay.brevo.com:587`);
