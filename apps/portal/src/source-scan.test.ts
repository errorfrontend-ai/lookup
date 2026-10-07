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

  it('no invisible or direction-changing characters anywhere in the source or its tests (they can make code read differently from how it runs)', () => {
    // Written as escapes here, so this file passes its own rule.
    const hiddenCharacters = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
    const everyFile = (readdirSync(SOURCE_ROOT, { recursive: true }) as string[]).filter((name) => /\.(ts|tsx|css)$/.test(name));
    const offenders = everyFile.filter((name) => hiddenCharacters.test(readFileSync(join(SOURCE_ROOT, name), 'utf8')));
    expect(everyFile.length).toBeGreaterThan(60);
    expect(offenders).toEqual([]);
  });

  it('is written mobile-first: wider layouts are added with min-width breakpoints, never taken away with max-width ones', () => {
    const narrowingVariant = /\bmax-(?:sm|md|lg|xl|2xl)\s*:/;
    const narrowingMediaQuery = /@media[^{]*max-width/;
    const offenders = (readdirSync(SOURCE_ROOT, { recursive: true }) as string[])
      .filter((name) => /\.(tsx|css)$/.test(name) && !/\.test\.tsx$/.test(name))
      .filter((name) => {
        const text = readFileSync(join(SOURCE_ROOT, name), 'utf8');
        return narrowingVariant.test(text) || narrowingMediaQuery.test(text);
      });
    expect(offenders).toEqual([]);
  });
});
