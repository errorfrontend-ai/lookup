import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDesignTokenStyles, GENERATED_STYLES_FILE, readDesignTokens } from '../../scripts/generate-design-token-styles';

const tokens = readDesignTokens();

/** WCAG 2.2 relative luminance and contrast ratio. */
function relativeLuminance(hexColor: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hexColor.slice(start, start + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((first, second) => second - first) as [
    number,
    number,
  ];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Every text-on-background pairing the portal uses. */
const TEXT_PAIRINGS: Array<[text: string, background: string]> = [
  ['ink', 'ground'],
  ['ink', 'surface'],
  ['muted', 'ground'],
  ['muted', 'surface'],
  ['onAccent', 'accent'],
  ['onAccent', 'accentHover'],
  ['accent', 'accentSoft'],
  ['accent', 'surface'],
  ['danger', 'dangerSoft'],
  ['danger', 'surface'],
  ['success', 'successSoft'],
  ['ink', 'warningSoft'],
  ['warning', 'warningSoft'],
  // Client avatars: the page colour as text on each token colour.
  ['surface', 'ink'],
  ['surface', 'success'],
  ['surface', 'warning'],
  ['surface', 'danger'],
  ['surface', 'muted'],
  // The frequency dial and toasts: the page colour on the ink panel, and softer text on it (70% over the panel).
  ['surface', 'ink'],
];

describe('design tokens', () => {
  it('the committed CSS matches tokens.json (run npm run generate:design-tokens after changing tokens)', () => {
    expect(readFileSync(GENERATED_STYLES_FILE, 'utf8')).toBe(buildDesignTokenStyles(tokens));
  });

  for (const mode of ['light', 'dark'] as const) {
    it.each(TEXT_PAIRINGS)(`${mode}: %s text on %s meets WCAG AA (4.5:1)`, (text, background) => {
      const palette = tokens.color[mode];
      expect(contrastRatio(palette[text] as string, palette[background] as string)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${mode}: the focus ring stands out from the page (3:1, WCAG non-text contrast)`, () => {
      const palette = tokens.color[mode];
      expect(contrastRatio(palette.focus as string, palette.ground as string)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(palette.focus as string, palette.surface as string)).toBeGreaterThanOrEqual(3);
    });
  }
});
