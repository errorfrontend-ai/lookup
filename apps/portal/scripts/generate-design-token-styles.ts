/**
 * Turns packages/design-tokens/tokens.json into the portal's CSS: colour variables for light and dark
 * mode, and a Tailwind theme that points at them (so `bg-surface`, `text-ink`, `rounded-lg` come from
 * the same tokens the listener app uses). Runs before `dev`, `build` and tests; a test fails if the
 * committed file and the tokens disagree.
 *
 *   npm run generate:design-tokens -w @lookup/portal
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface DesignTokens {
  color: { light: Record<string, string>; dark: Record<string, string> };
  font: { display: string; body: string };
  type: Record<string, { size: number; line: number; weight: number; family: 'display' | 'body' }>;
  space: Record<string, number>;
  radius: Record<string, number>;
  breakpoint: { web: Record<string, number> };
  motion: { fast: number; base: number; slow: number };
}

export const TOKENS_FILE = resolve(import.meta.dirname, '..', '..', '..', 'packages', 'design-tokens', 'tokens.json');
export const GENERATED_STYLES_FILE = resolve(import.meta.dirname, '..', 'src', 'design', 'design-tokens.css');

/** camelCase token names become kebab-case CSS names: accentHover → accent-hover. */
const toKebabCase = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

export function buildDesignTokenStyles(tokens: DesignTokens): string {
  const colorVariables = (palette: Record<string, string>) =>
    Object.entries(palette)
      .map(([name, value]) => `  --lookup-color-${toKebabCase(name)}: ${value};`)
      .join('\n');
  const themeColors = Object.keys(tokens.color.light)
    .map((name) => `  --color-${toKebabCase(name)}: var(--lookup-color-${toKebabCase(name)});`)
    .join('\n');
  const typeScale = Object.entries(tokens.type)
    .map(
      ([name, style]) =>
        `  --text-${name}: ${style.size / 16}rem;\n  --text-${name}--line-height: ${style.line / 16}rem;\n  --text-${name}--font-weight: ${style.weight};`,
    )
    .join('\n');
  const radii = Object.entries(tokens.radius)
    .map(([name, pixels]) => `  --radius-${name}: ${name === 'pill' ? '9999px' : `${pixels / 16}rem`};`)
    .join('\n');
  const breakpoints = Object.entries(tokens.breakpoint.web)
    .map(([name, pixels]) => `  --breakpoint-${name}: ${pixels / 16}rem;`)
    .join('\n');

  return `/* Generated from packages/design-tokens/tokens.json by scripts/generate-design-token-styles.ts — do not edit by hand. */

:root {
  color-scheme: light dark;
${colorVariables(tokens.color.light)}
  --lookup-motion-fast: ${tokens.motion.fast}ms;
  --lookup-motion-base: ${tokens.motion.base}ms;
  --lookup-motion-slow: ${tokens.motion.slow}ms;
}

@media (prefers-color-scheme: dark) {
  :root {
${colorVariables(tokens.color.dark)
  .split('\n')
  .map((line) => `  ${line}`)
  .join('\n')}
  }
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --lookup-motion-fast: 0ms;
    --lookup-motion-base: 0ms;
    --lookup-motion-slow: 0ms;
  }
}

@theme inline {
${themeColors}
  --font-display: ${tokens.font.display.replace('"Bricolage Grotesque"', '"Bricolage Grotesque Variable", "Bricolage Grotesque"')};
  --font-body: ${tokens.font.body.replace('"Public Sans"', '"Public Sans Variable", "Public Sans"')};
${typeScale}
${radii}
${breakpoints}
}
`;
}

export function readDesignTokens(): DesignTokens {
  return JSON.parse(readFileSync(TOKENS_FILE, 'utf8')) as DesignTokens;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(GENERATED_STYLES_FILE, buildDesignTokenStyles(readDesignTokens()), 'utf8');
  console.log('wrote src/design/design-tokens.css');
}
