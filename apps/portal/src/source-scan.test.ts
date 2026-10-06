import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = resolve(import.meta.dirname);

function portalSourceFiles(): Array<{ path: string; text: string }> {
  return (readdirSync(SOURCE_ROOT, { recursive: true }) as string[])
    .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.split(sep).includes('test'))
    .map((name) => ({ path: relative(SOURCE_ROOT, join(SOURCE_ROOT, name)).split(sep).join('/'), text: readFileSync(join(SOURCE_ROOT, name), 'utf8') }));
}

/** Whole-file rules over the portal's own source (tests excluded), the same idea as the API's source scan. */
describe('portal source scan', () => {
  it('reads the source it is meant to read', () => {
    const paths = portalSourceFiles().map((file) => file.path);
    expect(paths.length).toBeGreaterThan(30);
    expect(paths).toContain('app/portal-shell.tsx');
  });

  it('every colour comes from the design tokens: no hex or rgb() colour written in a component', () => {
    const colourLiteral = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
    const offenders = portalSourceFiles().filter((file) => colourLiteral.test(file.text)).map((file) => `${file.path}: ${file.text.match(colourLiteral)?.[0]}`);
    expect(offenders).toEqual([]);
  });

  it('nothing in the portal shows an error\'s own message to a person: only the API\'s plain message or ours', () => {
    const showsRawErrorText = /\{\s*(?:error|err|caughtError)\.message\s*\}|\{\s*String\(\s*(?:error|err|caughtError)\s*\)\s*\}/;
    const offenders = portalSourceFiles().filter((file) => !file.path.startsWith('api/') && showsRawErrorText.test(file.text)).map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('no console output left in the app', () => {
    expect(portalSourceFiles().filter((file) => /\bconsole\s*\.\s*(log|info|warn|error|debug)\s*\(/.test(file.text)).map((file) => file.path)).toEqual([]);
  });
});
