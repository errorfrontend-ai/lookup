// Copies the files the compiled setup scripts read while they run, which tsc does not copy (it copies only code):
// the common-password blocklist the super-admin command checks passwords against. Run by `npm run build:tools`.
import { cpSync } from 'node:fs';

cpSync(
  new URL('../src/features/authentication/password-blocklist/', import.meta.url),
  new URL('../dist-tools/src/features/authentication/password-blocklist/', import.meta.url),
  { recursive: true },
);
