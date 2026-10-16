import { z } from 'zod';

/**
 * Imported for its effect, first of all, by pages whose Content-Security-Policy refuses `eval` (the station portal).
 * zod probes whether it may compile validators when each schema is created, which such a page reports as a policy
 * violation; with this set first, it never probes and checks the same rules without compiled code. It must run before
 * any schema exists, so it lives apart from the schemas: `import '@lookup/contracts/validation-without-eval';`
 */
z.config({ jitless: true });
