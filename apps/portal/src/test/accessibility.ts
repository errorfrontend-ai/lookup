import axe from 'axe-core';

/**
 * What axe finds wrong with the page as it is drawn now, one line per problem (the rule, what it means,
 * and up to three of the elements it found). Colour contrast is left to the design token test: jsdom
 * draws nothing, so axe cannot measure colours here.
 */
export async function findAccessibilityProblems(root: Element = document.body): Promise<string[]> {
  const results = await axe.run(root, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return results.violations.map((violation) => `${violation.id}: ${violation.help} — ${violation.nodes.slice(0, 3).map((node) => node.target.join(' ')).join(' | ')}`);
}
