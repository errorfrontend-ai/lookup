// Lets a test start the API's TypeScript in a child process (node --import this-file src/main.ts),
// compiled by SWC with the same settings as vitest.config.ts. Test use only.
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
