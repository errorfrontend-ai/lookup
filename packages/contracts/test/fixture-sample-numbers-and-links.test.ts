import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES_DIRECTORY } from './fixtures.js';

/**
 * Sample data in the shared fixtures (contract §2.7, P4-D24; P6 design §4.5 and Q13). The fixture folders contract
 * §2.6 adds or edits use only the drama range +44 7700 900NNN for phone numbers and example.com for links: never a
 * realistic Zambian number (+260…, 0977…, 0966…, in any written form) and never an example.co.zm link, which is not
 * reserved. The other folders still hold the two old sample numbers and wait for the separate sweep (contract §2.7,
 * correction 2), so the scan covers exactly the §2.6 folders, and a second test keeps the old numbers inside the
 * folders the sweep cleans.
 */
const CONTRACT_SECTION_2_6_FOLDERS = [
  'errors/envelopes',
  'listener-outbox',
  'recognition/engagement-input',
  'recognition/listener-app-versions',
  'recognition/listener-station-list',
  'recognition/recognition-report-input',
  'recognition/recognize-request',
  'recognition/recognize-response',
  'recognition/station-choice-input',
];

/** The folders that still hold the old sample numbers, for the separate sweep (contract §2.7, correction 2). */
const FOLDERS_THE_SWEEP_CLEANS = ['action-card', 'phone-numbers'];

/** Ids are hex digits in groups; they are taken out first, so their digits never read as a phone number. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Each realistic form, by name. Digits may be grouped with spaces or hyphens. The bounds keep a form from matching
 * inside a longer number, so the drama range (+447700900NNN, 07700 900NNN) is never taken for a Zambian one.
 */
const REALISTIC_FORMS: ReadonlyArray<readonly [string, RegExp]> = [
  ['a +260 or 00260 number', /(?:\+|(?<!\d)00)\s*260/g],
  ['a 260 number without its plus', /(?<![\w.+-])260(?:[\s-]?\d){9}(?![\w-])/g],
  ['a Zambian mobile number in local form', /(?<![\w.+-])0[\s-]?[79][5-7](?:[\s-]?\d){7}(?![\w-])/g],
  ['a Zambian mobile number without its leading 0', /(?<![\w.+-])[79][5-7](?:[\s-]?\d){7}(?![\w-])/g],
  ['an example.co.zm link', /example\.co\.zm/gi],
];

/** Every realistic number or example.co.zm link in [text], as "<form>: <what was found>". */
function realisticSampleDataIn(text: string): string[] {
  const withoutIds = text.replace(UUID, ' ');
  return REALISTIC_FORMS.flatMap(([form, pattern]) => [...withoutIds.matchAll(pattern)].map((match) => `${form}: ${match[0]}`));
}

/** Every file under [folder], at any depth. */
function filesUnder(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(folder, entry.name)) : [join(folder, entry.name)],
  );
}

const pathFrom = (root: string, file: string) => relative(root, file).replaceAll('\\', '/');

/** Every finding in the files of [folders] under [root], as "<path>: <form>: <what was found>". */
function findingsIn(root: string, folders: readonly string[]): string[] {
  return folders.flatMap((folder) =>
    filesUnder(resolve(root, folder)).flatMap((file) =>
      realisticSampleDataIn(readFileSync(file, 'utf8')).map((finding) => `${pathFrom(root, file)}: ${finding}`),
    ),
  );
}

describe('the sample numbers and links in the fixture folders of contract §2.6', () => {
  it('every folder §2.6 adds or edits is there and is read, every file of it', () => {
    for (const folder of CONTRACT_SECTION_2_6_FOLDERS) {
      expect(existsSync(resolve(FIXTURES_DIRECTORY, folder)), folder).toBe(true);
      expect(filesUnder(resolve(FIXTURES_DIRECTORY, folder)).length, folder).toBeGreaterThan(0);
    }
    expect(CONTRACT_SECTION_2_6_FOLDERS.flatMap((folder) => filesUnder(resolve(FIXTURES_DIRECTORY, folder))).length).toBeGreaterThan(80);
  });

  it('hold no realistic number in any written form and no example.co.zm link', () => {
    expect(findingsIn(FIXTURES_DIRECTORY, CONTRACT_SECTION_2_6_FOLDERS)).toEqual([]);
  });

  it('the scan finds every realistic form, and passes the drama range, ids, times and other numbers', () => {
    const realistic = [
      '+260977123456',
      '+260 97 712 3456',
      '00260966123456',
      '260977123456',
      'https://wa.me/260966123456',
      '0977123456',
      '0966 123 456',
      '0977-123-456',
      '977123456',
      '966 123 456',
      'https://example.co.zm/menu',
      'https://EXAMPLE.CO.ZM/',
    ];
    for (const text of realistic) expect(realisticSampleDataIn(`"value": "${text}"`), text).not.toEqual([]);
    const safe = [
      '+447700900001',
      '+44 7700 900777',
      '447700900777',
      '07700900777',
      '07700 900777',
      '7700 900777',
      'https://example.com/menu?utm_source=lookup',
      '0192a6c4-0000-4000-8000-000000000001',
      '26097712-3456-4000-8000-000000000001',
      '2026-10-07T06:30:00.000Z',
      '"retry_after_seconds": 2400',
      '"maximum_clip_bytes": 262144',
      '"latitude": -15.4167, "longitude": 28.2833',
    ];
    for (const text of safe) expect(realisticSampleDataIn(`"value": "${text}"`), text).toEqual([]);
  });

  it('a realistic number or an example.co.zm link planted in a copy of the folders fails the scan', () => {
    const copy = mkdtempSync(join(tmpdir(), 'lookup-fixture-scan-'));
    try {
      for (const folder of CONTRACT_SECTION_2_6_FOLDERS) cpSync(resolve(FIXTURES_DIRECTORY, folder), resolve(copy, folder), { recursive: true });
      expect(findingsIn(copy, CONTRACT_SECTION_2_6_FOLDERS)).toEqual([]);

      const plant = (path: string, safeValue: string, plantedValue: string) => {
        const file = resolve(copy, path);
        const text = readFileSync(file, 'utf8');
        expect(text, path).toContain(safeValue);
        writeFileSync(file, text.replace(safeValue, plantedValue));
      };
      plant('recognition/engagement-input/invalid/phone-number-in-body.json', '+447700900001', '+260977123456');
      plant('recognition/recognize-response/valid/match-campaign.json', 'https://example.com/', 'https://example.co.zm/');
      plant('recognition/recognize-response/valid/no-match.json', '"description": "', '"description": "Call 0966 123 456. ');

      expect(findingsIn(copy, CONTRACT_SECTION_2_6_FOLDERS)).toEqual([
        'recognition/engagement-input/invalid/phone-number-in-body.json: a +260 or 00260 number: +260',
        'recognition/recognize-response/valid/match-campaign.json: an example.co.zm link: example.co.zm',
        'recognition/recognize-response/valid/no-match.json: a Zambian mobile number in local form: 0966 123 456',
      ]);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it('the old numbers left anywhere else are only in the folders the separate sweep cleans', () => {
    const isInSection26Folder = (path: string) => CONTRACT_SECTION_2_6_FOLDERS.some((folder) => path.startsWith(`${folder}/`));
    const foldersWithOldNumbers = new Set(
      filesUnder(FIXTURES_DIRECTORY)
        .map((file) => pathFrom(FIXTURES_DIRECTORY, file))
        .filter((path) => !isInSection26Folder(path))
        .filter((path) => realisticSampleDataIn(readFileSync(resolve(FIXTURES_DIRECTORY, path), 'utf8')).length > 0)
        .map((path) => path.split('/')[0]),
    );
    // When the sweep has cleaned a folder, this fails: scan that folder in the test above from then on.
    expect([...foldersWithOldNumbers].sort(), 'folders outside §2.6 that hold realistic numbers').toEqual(FOLDERS_THE_SWEEP_CLEANS);
  });
});
