import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const API_SOURCE = resolve(REPOSITORY_ROOT, 'apps', 'api', 'src');
/** Production source only: tests are allowed to spell out the forbidden things they check for. */
const PRODUCTION_SOURCE_FOLDERS = ['apps/api/src', 'apps/portal/src', 'packages/contracts/src'];

interface SourceFile {
  path: string;
  text: string;
}

function readSourceFiles(folder: string, extensions = /\.(ts|tsx)$/): SourceFile[] {
  const absoluteFolder = resolve(REPOSITORY_ROOT, folder);
  return (readdirSync(absoluteFolder, { recursive: true }) as string[])
    .filter((name) => extensions.test(name) && !/\.test\.tsx?$/.test(name) && !name.split(sep).includes('test'))
    .map((name) => ({
      path: relative(REPOSITORY_ROOT, join(absoluteFolder, name)).split(sep).join('/'),
      text: readFileSync(join(absoluteFolder, name), 'utf8'),
    }));
}

/** Files (whole, so multi-line shapes are caught) whose text matches the pattern, with the matched text. */
function filesMatching(files: SourceFile[], pattern: RegExp, allowed: (path: string) => boolean = () => false): string[] {
  return files.filter((file) => !allowed(file.path) && pattern.test(file.text)).map((file) => `${file.path}: ${file.text.match(pattern)?.[0]}`);
}

const apiFiles = readSourceFiles('apps/api/src');
const productionFiles = PRODUCTION_SOURCE_FOLDERS.flatMap((folder) => readSourceFiles(folder));

/**
 * Rules checked over every source file read whole (S1-TESTS-14), so a shape split across lines,
 * such as an error's message on its own line inside a response object, cannot slip through.
 */
describe('source scan', () => {
  it('reads the source it is meant to read', () => {
    expect(apiFiles.length).toBeGreaterThan(40);
    expect(apiFiles.some((file) => file.path === 'apps/api/src/common/errors/all-exceptions.filter.ts')).toBe(true);
    expect(API_SOURCE).toContain(join('apps', 'api', 'src'));
  });

  it('only the exception filter writes HTTP responses', () => {
    const writesResponse = /\b(response|res|reply)\s*\.\s*(status|json|send|end|sendStatus|write)\s*\(/;
    expect(filesMatching(apiFiles, writesResponse, (path) => path.endsWith('common/errors/all-exceptions.filter.ts'))).toEqual([]);
  });

  it("an error's own message never becomes a public message, on one line or across several", () => {
    // Any error-like name (error, caughtError, driverException, cause, reason…), with or without String().
    // publicError is the filter's own catalogue entry, written for people, so it is the one exception.
    const errorLikeName = String.raw`(?!public)\w*(?:error|Error|err|Err|exception|Exception|cause|Cause|reason|Reason)`;
    const relaysErrorText = new RegExp(
      String.raw`\b(?:publicMessage|message)\s*:\s*[^,}]*?\b${errorLikeName}\??\.message\b` +
        String.raw`|\b(?:publicMessage|message)\s*:\s*String\(\s*${errorLikeName}\s*\)`,
    );
    expect(filesMatching(apiFiles, relaysErrorText)).toEqual([]);
  });

  it('S2-AUTHORIZATION-08: feature code reaches the database only through StationScopedTransaction (no repositories, no direct data source)', () => {
    const directDatabaseAccess = /@InjectRepository|@InjectDataSource|getRepository\s*\(|createQueryBuilder\s*\(/;
    const mayUseDataSourceDirectly = (path: string) =>
      path.startsWith('apps/api/src/infrastructure/') ||
      // Sign-in runs before any station context exists; it calls SECURITY DEFINER functions only.
      path.startsWith('apps/api/src/features/authentication/') ||
      path.startsWith('apps/api/src/features/health/');
    expect(filesMatching(apiFiles, directDatabaseAccess, mayUseDataSourceDirectly)).toEqual([]);
  });

  it('S1-MIGRATIONS-04: one data-source definition, used by both the API and the migration script', () => {
    const apiAndScripts = [...apiFiles, ...readSourceFiles('apps/api/scripts')];
    const definesConnection = /type\s*:\s*['"]postgres['"]/;
    expect(filesMatching(apiAndScripts, definesConnection, (path) => path.endsWith('infrastructure/database/data-source-options.ts'))).toEqual([]);
    for (const user of ['apps/api/src/infrastructure/database/database.module.ts', 'apps/api/scripts/run-migrations.ts']) {
      expect(apiAndScripts.find((file) => file.path === user)?.text, user).toContain('lookupDataSourceOptions(');
    }
  });

  it('API code logs through the structured logger, never console', () => {
    expect(filesMatching(apiFiles, /\bconsole\s*\.\s*(log|info|warn|error|debug)\s*\(/)).toEqual([]);
  });

  it('S1-MIGRATIONS-02: the application never synchronises or migrates the schema itself', () => {
    expect(filesMatching(apiFiles, /\b(synchronize|migrationsRun|dropSchema)\s*:\s*true\b/)).toEqual([]);
  });

  it('S1-NAMING-04, S1-NAMING-05: no TenantTx and no "tenant" anywhere in production source', () => {
    expect(filesMatching(productionFiles, /TenantTx|\btenants?\b|tenant_id|tenantId/i)).toEqual([]);
  });

  it('no package script or workflow swallows a failure', () => {
    const configurationFiles = [
      ...['package.json', 'apps/api/package.json', 'apps/portal/package.json', 'packages/contracts/package.json'].map((path) => ({
        path,
        text: readFileSync(resolve(REPOSITORY_ROOT, path), 'utf8'),
      })),
    ];
    const swallowsFailure = /\|\|\s*(true|echo|exit 0|:)\b|--passWithNoTests|continue-on-error\s*:\s*true/;
    expect(filesMatching(configurationFiles, swallowsFailure)).toEqual([]);
  });

  it('no invisible or direction-changing characters in the API, the contracts or their tests (code must read as it runs; write them as escapes)', () => {
    // Built from code points, so this file never contains the characters it looks for.
    const ranges = [[0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]] as const;
    const hiddenCharacter = new RegExp(`[${ranges.map(([first, last]) => `${String.fromCodePoint(first)}-${String.fromCodePoint(last)}`).join('')}]`);
    const folders = ['apps/api/src', 'apps/api/test', 'apps/api/scripts', 'packages/contracts/src', 'packages/contracts/test', 'packages/contracts/fixtures', 'packages/contracts/schemas'];
    const everyFile = folders.flatMap((folder) =>
      (readdirSync(resolve(REPOSITORY_ROOT, folder), { recursive: true }) as string[])
        .filter((name) => /\.(ts|json)$/.test(name))
        .map((name) => `${folder}/${name.split(sep).join('/')}`),
    );
    expect(everyFile.length).toBeGreaterThan(100);
    expect(everyFile.filter((path) => hiddenCharacter.test(readFileSync(resolve(REPOSITORY_ROOT, path), 'utf8')))).toEqual([]);
  });
});
