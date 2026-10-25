import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { vapidPublicKeyOf } from '../src/features/notifications/web-push.js';

const TOOL = fileURLToPath(new URL('../../../scripts/make-deploy-secrets.mjs', import.meta.url));
const ALL_SECRETS = ['AUTHENTICATION_SECRET', 'TWO_FACTOR_ENCRYPTION_SECRET', 'LISTENER_INSTALL_TOKEN_SECRET', 'LISTENER_INSTALL_ID_PEPPER', 'LISTENER_EMAIL_ENCRYPTION_SECRET'];
const run = (...names: string[]) => spawnSync(process.execPath, [TOOL, ...names], { encoding: 'utf8' });
const linesOf = (output: string) => output.split('\n').filter((line) => line.trim() !== '');

/**
 * npm run deploy:new-secrets (docs/runbooks/deploying-to-render.md): every secret the API needs, made on this computer,
 * in the shape the API accepts; and, for a site already running, only the one a release adds, so the others are never
 * replaced by mistake (replacing them signs everyone out, makes phones register again and locks super admins' codes).
 */
describe('the deploy secrets tool', () => {
  it('with no names, prints all five for a first deploy, each 32 random bytes in base64url, and warns not to paste them all into a running site', () => {
    const result = run();
    expect(result.status).toBe(0);
    const lines = linesOf(result.stdout);
    expect(lines.map((line) => line.split('=')[0])).toEqual(ALL_SECRETS);
    for (const line of lines) expect(line).toMatch(/^[A-Z_]+=[A-Za-z0-9_-]{43}$/);
    expect(new Set(lines.map((line) => line.split('=')[1])).size).toBe(5);
    expect(result.stderr).toContain('FIRST deploy');
    expect(result.stderr).toContain('npm run deploy:new-secrets -- LISTENER_EMAIL_ENCRYPTION_SECRET');
  });

  it('with a name, prints only that secret and no warning: what a running site needs when a release adds one', () => {
    const result = run('LISTENER_EMAIL_ENCRYPTION_SECRET');
    expect(result.status).toBe(0);
    expect(linesOf(result.stdout)).toEqual([expect.stringMatching(/^LISTENER_EMAIL_ENCRYPTION_SECRET=[A-Za-z0-9_-]{43}$/)]);
    expect(result.stderr).toBe('');
  });

  it('P5C-ROLLOUT-01: WEB_PUSH_KEYS prints a matching push key pair in the shape the API accepts, and says to add the contact email', () => {
    const result = run('WEB_PUSH_KEYS');
    expect(result.status).toBe(0);
    const lines = linesOf(result.stdout);
    expect(lines).toEqual([expect.stringMatching(/^WEB_PUSH_PUBLIC_KEY=[A-Za-z0-9_-]{87}$/), expect.stringMatching(/^WEB_PUSH_PRIVATE_KEY=[A-Za-z0-9_-]{43}$/)]);
    const [publicKey, privateKey] = lines.map((line) => line.split('=')[1] as string);
    expect(vapidPublicKeyOf(privateKey as string)).toBe(publicKey);
    expect(result.stderr).toContain('WEB_PUSH_CONTACT_EMAIL');
    // Not part of a first deploy's five: push is optional until it is added.
    expect(linesOf(run().stdout).some((line) => line.startsWith('WEB_PUSH'))).toBe(false);
  });

  it('refuses a name that is not a deploy secret, prints no secret, and lists the ones there are', () => {
    const result = run('LISTENER_EMAIL_ENCRYPTION_SECRET', 'DATABASE_URL');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Not a deploy secret: DATABASE_URL');
    for (const name of ALL_SECRETS) expect(result.stderr).toContain(name);
  });
});
