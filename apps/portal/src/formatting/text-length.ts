/** Characters as people count them (an emoji is one), which is how every length rule in Look Up is counted. */
export function countCharacters(text: string): number {
  return [...text].length;
}

/**
 * The browser's own limit for a box. It counts UTF-16 units, in which an emoji takes two, so it is set
 * to twice the rule: the browser never cuts text off before the real limit, and the rule (with its
 * counter and message) has the last word.
 */
export function browserMaxLength(maximumCharacters: number): number {
  return maximumCharacters * 2;
}
