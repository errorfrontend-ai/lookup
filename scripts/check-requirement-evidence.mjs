// Checks that every ticked requirement points at evidence that exists: each "path :: suite > test name"
// after *Evidence:* must name a file in the repository, and the last part of the name must appear in that
// file or in the shared fixtures (tests named after fixture cases). A tick with no evidence fails too.
//   node scripts/check-requirement-evidence.mjs          (exits 1 when anything is missing)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const requirementsFolder = join(repositoryRoot, 'docs', 'requirements');
const fixtureFolders = [join(repositoryRoot, 'packages', 'contracts', 'fixtures')];

function filesUnder(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

// Fixture contents and fixture names: parametrised tests are named after fixture files or their values.
const fixtureFiles = fixtureFolders.flatMap(filesUnder);
const fixtureText = [...fixtureFiles.map((path) => readFileSync(path, 'utf8')), ...fixtureFiles.map((path) => path.split(/[\\/]/).at(-1).replace(/\.[a-z]+$/, ''))].join('\n');

const escapeForPattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a test name appears in a test file. A name may be written in the evidence with "<…>" standing
 * for several cases, and a parametrised test may be written with "%s" for each value; a value that came
 * from a fixture must appear in the fixtures or the test file.
 */
function testNameIsPresent(testName, text) {
  // "(every case, through expectErrorEnvelope)": every test in the file, through the helper it names,
  // which may live in another file ("through assertNoInternalDetails in apps/api/test/support/….ts").
  if (testName.startsWith('(')) {
    const through = /through (\w+)(?: in ([\w./-]+))?/.exec(testName);
    if (!through) return true;
    const [, helper, helperPath] = through;
    const helperText = helperPath && existsSync(join(repositoryRoot, helperPath)) ? textOf(join(repositoryRoot, helperPath)) : text;
    return helperText.includes(helper);
  }
  // A note in brackets after the name ("… internals (every case)") is not part of it.
  testName = testName.replace(/\s*\([^)]*\)$/, '');
  const plainName = testName.replace(/<[^>]*>/g, '').trim();
  // The whole name must be there: a shared beginning is not enough, or a renamed test would still pass.
  if (!/<[^>]*>/.test(testName) && (text.includes(testName) || fixtureText.includes(testName))) return true;
  const sample = testName.replace(/<[^>]*>/g, 'X');
  const templates = [...text.matchAll(/'([^'\n]*%[sdij][^'\n]*)'|"([^"\n]*%[sdij][^"\n]*)"|`([^`\n]*%[sdij][^`\n]*)`/g)].map((match) => match[1] ?? match[2] ?? match[3]);
  for (const template of templates) {
    const pattern = new RegExp(`^${escapeForPattern(template).replace(/%[sdij]/g, '(.+?)')}$`);
    const match = pattern.exec(sample);
    if (!match) continue;
    const values = match.slice(1).filter((value) => value !== 'X');
    if (values.every((value) => text.includes(value) || fixtureText.includes(value))) return true;
  }
  return plainName.length > 0 && text.includes(plainName);
}
const fileTextCache = new Map();
const textOf = (path) => {
  // A name written in single quotes escapes its apostrophes (station\'s); evidence is written as people read it.
  if (!fileTextCache.has(path)) fileTextCache.set(path, readFileSync(path, 'utf8').replaceAll("\\'", "'"));
  return fileTextCache.get(path);
};

const problems = [];
let ticked = 0;
let references = 0;
/** Ticked and total items for each phase (the part of the id before the first dash: S1, S2, P5A …). */
const countsByPhase = new Map();

for (const checklist of filesUnder(requirementsFolder).filter((path) => path.endsWith('.md'))) {
  for (const line of readFileSync(checklist, 'utf8').split(/\r?\n/)) {
    const phase = /^- \[[ x]\] \*\*([A-Z0-9]+)-/.exec(line)?.[1];
    if (phase) {
      const counts = countsByPhase.get(phase) ?? { ticked: 0, total: 0 };
      counts.total += 1;
      if (line.startsWith('- [x]')) counts.ticked += 1;
      countsByPhase.set(phase, counts);
    }
    if (!line.startsWith('- [x]')) continue;
    ticked += 1;
    const item = /^- \[x\] \*\*([A-Z0-9-]+)\*\*/.exec(line)?.[1] ?? '?';
    const evidence = /\*Evidence:\*(.*?)(?:\[T[0-9]|\*[A-Z][a-z]+[^*]*:\*|$)/.exec(line)?.[1];
    if (!evidence) {
      problems.push(`${item}: ticked with no *Evidence:*`);
      continue;
    }
    for (const part of evidence.split(/\s;\s/)) {
      const reference = /([\w./-]+\.(?:ts|tsx|py|dart|js|mjs))\s*::\s*(.+)/.exec(part.trim().replace(/\.$/, ''));
      if (!reference) continue;
      references += 1;
      const [, path, name] = reference;
      const fullPath = join(repositoryRoot, path);
      if (!existsSync(fullPath)) {
        problems.push(`${item}: file not found: ${path}`);
        continue;
      }
      // The test's own name is the last part after ">"; parameter lists in brackets and quotes are not part of it,
      // and a note after the reference ("… :: test_name. Narrowed in review round 1: …") ends at the first sentence break.
      const testName = name.split(/\.\s/)[0].replace(/\.$/, '').split(' > ').at(-1).trim().replace(/\[.*$/, '').replace(/^`|`$/g, '').trim();
      if (!testName) continue;
      if (!testNameIsPresent(testName, textOf(fullPath))) problems.push(`${item}: test not found: ${path} :: ${testName}`);
    }
  }
}

console.log(`${ticked} ticked requirements, ${references} evidence references checked in ${relative(repositoryRoot, requirementsFolder)}`);
console.log([...countsByPhase].map(([phase, counts]) => `  ${phase}: ${counts.ticked} of ${counts.total} ticked`).join('\n'));
if (problems.length > 0) {
  console.log(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.log(`  ${problem}`);
  process.exit(1);
}
console.log('Every ticked requirement points at evidence that exists.');
