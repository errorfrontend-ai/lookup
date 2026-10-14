import { createHash } from 'node:crypto';
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

/**
 * The SHA-256 of each migration as released (pushed), with Windows line endings evened out. A released
 * migration has run on some database; changing it would leave that database different from a new one.
 */
const RELEASED_MIGRATION_DIGESTS: Record<string, string> = {
  '1790960000000-Foundation.ts': '38b41f4d4af4af94668d84e7c2af02da71bec2bcde04c685ba987c1db4338bd4',
  '1791100000000-StationPortal.ts': '5d5eb68f03202ae1ac5e715ba304f27eedeb31f797eb1170177d6428d72c8fa2',
  '1791150000000-UploadRefusalReasons.ts': '998c857d0cad765950b3a39617965533ad2cf4e48726bdd60b6bc188e8d015a2',
  '1791200000000-AdCardsAndSchedules.ts': '066aa880fb2581bebf21ba6410e2a15213393f5caaae7c2103121e201cf19a31',
  '1791300000000-DatabaseHardening.ts': '885fe8747059a6dc325960dded1563d4099bb0fc49d649364cd5fa951761a711',
  '1791400000000-AdHistoryIndexes.ts': 'b99a0d25333d8b520a4bc60b374a0f49750160c8e2b912c681b132af4bf95857',
  '1791500000000-EngineHookup.ts': 'd3ef959bea88ef4891dacd49d6ea387804b2a6052c3e467fc49a227b8027c3a5',
  '1791600000000-StationResolution.ts': '6667c9ac4058f2d3f7d7f2dc6cac038a419200b1152e4caf68886f4d0f87f9bb',
  '1791700000000-FingerprintVersionTwo.ts': '8933e3d2a3bca154a208b6db1f40ac98c7db2258d643d14f6c354a571a2a194a',
};

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
      // So do sign-up's step 1, the email link and an invitation link (P5A design §2.8), only through such functions.
      path === 'apps/api/src/features/registration/registration.service.ts' ||
      path === 'apps/api/src/features/members/station-team.ts' ||
      path.startsWith('apps/api/src/features/health/');
    expect(filesMatching(apiFiles, directDatabaseAccess, mayUseDataSourceDirectly)).toEqual([]);
  });

  it('P5A design §3.1: only the admin feature uses the super admin’s connection, which sees every station', () => {
    const usesAdminConnection = /AdminTransaction|ADMIN_DATA_SOURCE/;
    const mayUseIt = (path: string) =>
      path.startsWith('apps/api/src/features/admin/') || path === 'apps/api/src/infrastructure/admin-database/admin-database.module.ts' ||
      path === 'apps/api/src/app.module.ts';
    expect(filesMatching(apiFiles, usesAdminConnection, mayUseIt)).toEqual([]);
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

  it('S3-ARCHITECTURE-03: the API decodes no audio and computes no fingerprints: it only queues clips for the workers', () => {
    const manifest = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, 'apps/api/package.json'), 'utf8')) as Record<string, Record<string, string>>;
    const packages = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(packages.length).toBeGreaterThan(10);
    expect(packages.filter((name) => /ffmpeg|audio|wav|mp3|aac|opus|ogg|fft|dsp|meyda|essentia|chromaprint|fingerprint|sox/i.test(name))).toEqual([]);
    expect(filesMatching(apiFiles, /\bfft\b|spectrogram|\bstft\b|decodeAudio|AudioContext|node:child_process|from 'child_process'/i)).toEqual([]);
  });

  it('S3-STACK-02, S3-STACK-04: the queue, circuit-breaker and multipart libraries are pinned exactly, in the manifest and the lock file', () => {
    const manifest = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, 'apps/api/package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const lock = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> };
    for (const [name, version] of [['bullmq', '6.3.11'], ['opossum', '10.0.0'], ['busboy', '1.6.0']]) {
      expect(manifest.dependencies[name as string], name).toBe(version);
      const locked = Object.entries(lock.packages).filter(([path]) => path.endsWith(`node_modules/${name}`)).map(([, entry]) => entry.version);
      expect(locked, name).toEqual([version]);
    }
  });

  it('S3-ENGINE-16: ADR-001 records the hash column type and the benchmark figure it rests on', () => {
    const decision = readFileSync(resolve(REPOSITORY_ROOT, 'docs/adr/ADR-001-fingerprint-engine.md'), 'utf8');
    expect(decision).toMatch(/\*\*Hashes\*\* are exact packed integers[^]*?`bigint` column[^]*?largest hash these settings can produce is about\s+5\.3 × 10\^7/);
  });

  it('S3-PRIVACY-01: nothing on the listener path can write a file or store a clip: no file system or object storage in the recognition, installs and queue code', () => {
    const listenerPath = apiFiles.filter((file) => /^apps\/api\/src\/(features\/recognition|features\/listener-installs|common\/listener-authentication|infrastructure\/job-queues)\//.test(file.path));
    expect(listenerPath.length).toBeGreaterThan(10);
    // The ingest queue signs an ad's download address with object storage: that is the station's upload, not a clip.
    const isAdIngest = (path: string) => path.endsWith('/job-queues/ingest-queue.ts');
    expect(filesMatching(listenerPath, /from '(?:node:)?fs(?:\/promises)?'|tmpdir|createWriteStream|writeFile|object-storage/, isAdIngest)).toEqual([]);
  });

  it('S3-STRUCTURE-01: none of the plan’s short names survive in the API, the portal, the contracts or the workers', () => {
    const pythonFiles = ['services/fingerprinter/workers', 'services/fingerprinter/lookup_fingerprint'].flatMap((folder) => readSourceFiles(folder, /\.py$/));
    const schemaFiles = readSourceFiles('packages/contracts/schemas', /\.json$/);
    const everyFile = [...productionFiles, ...pythonFiles, ...schemaFiles];
    expect(pythonFiles.length).toBeGreaterThan(10);
    const shortNames = /\b(?:recog|fp|asset_key|fp_key|clip_ms|offset_ms|latency_ms|t_off|fp_version|fpVersion|audioB64|deadlineAt|assetKey)\b|\brecog\.|\bfp\.|["'](?:w|h)["']\s*:/;
    expect(filesMatching(everyFile, shortNames)).toEqual([]);
  });

  it('S3-DATABASE-08: a released migration never changes; new schema goes in a new migration', () => {
    // Line endings are evened out first, so a checkout on Windows reads the same.
    const released = RELEASED_MIGRATION_DIGESTS;
    const folder = resolve(API_SOURCE, 'infrastructure', 'database', 'migrations');
    const digests = Object.fromEntries(
      Object.keys(released).map((fileName) => [fileName, createHash('sha256').update(readFileSync(resolve(folder, fileName), 'utf8').replace(/\r\n/g, '\n')).digest('hex')]),
    );
    expect(digests).toEqual(released);
  });

  it('no unit or API test is skipped or singled out, so a green run means every test ran', () => {
    // Built from pieces, so this file does not match its own rule. (The browser tests in apps/portal/e2e
    // skip on purpose by screen size: the keyboard check runs on the desktop, the tap check on the phone.)
    const skipsOrSinglesOut = new RegExp(`\\b(?:it|test|describe)\\.(?:${['skip', 'only', 'todo', 'skipIf', 'runIf'].join('|')})\\b|\\bx(?:it|describe)\\(`);
    const testFiles = ['apps/api/test', 'apps/portal/src', 'packages/contracts/test'].flatMap((folder) =>
      (readdirSync(resolve(REPOSITORY_ROOT, folder), { recursive: true }) as string[])
        .filter((name) => /\.test\.tsx?$/.test(name))
        .map((name) => ({ path: `${folder}/${name.split(sep).join('/')}`, text: readFileSync(resolve(REPOSITORY_ROOT, folder, name), 'utf8') })),
    );
    expect(testFiles.length).toBeGreaterThan(70);
    expect(filesMatching(testFiles, skipsOrSinglesOut)).toEqual([]);
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
