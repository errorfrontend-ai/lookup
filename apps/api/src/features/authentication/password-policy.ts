import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  countPasswordCharacters,
  PASSWORD_MAXIMUM_LENGTH,
  PASSWORD_MINIMUM_LENGTH,
  type PasswordPolicyReason,
} from '@lookup/contracts';
import { Injectable } from '@nestjs/common';

/** What a new password must not contain: words a guesser would try first for this person. */
export interface PersonalDetails {
  fullName?: string;
  email?: string;
  stationNames?: string[];
}

const SERVICE_WORDS = ['lookup', 'look up'];
const MINIMUM_PERSONAL_WORD_LENGTH = 4;
const LONGEST_REPEATED_UNIT = 4;

/**
 * NIST SP 800-63B revision 4 password rules, checked when a password is set (not at sign-in, so a
 * policy change never locks anyone out): 15–128 characters, not a common password, not built from
 * the person's own details or the service's name, not a run of one character, a short repeated
 * unit, or a plain ascending or descending sequence. No composition rules, no expiry.
 */
@Injectable()
export class PasswordPolicy {
  private readonly commonPasswords: ReadonlySet<string> = loadCommonPasswords();

  /** The reason the password is refused, or null when it is acceptable. */
  check(password: string, personalDetails: PersonalDetails = {}): PasswordPolicyReason | null {
    const characterCount = countPasswordCharacters(password);
    if (characterCount < PASSWORD_MINIMUM_LENGTH) return 'too_short';
    if (characterCount > PASSWORD_MAXIMUM_LENGTH) return 'too_long';
    const comparablePassword = password.normalize('NFC').toLowerCase();
    if (this.commonPasswords.has(comparablePassword) || isRepetitiveOrSequential(Array.from(comparablePassword))) {
      return 'too_common';
    }
    const personalWords = [...SERVICE_WORDS, ...wordsFrom(personalDetails)];
    if (personalWords.some((word) => comparablePassword.includes(word))) return 'contains_personal_details';
    return null;
  }

  get commonPasswordCount(): number {
    return this.commonPasswords.size;
  }
}

function loadCommonPasswords(): ReadonlySet<string> {
  const blocklistFile = resolve(import.meta.dirname, 'password-blocklist', 'common-passwords.txt.gz');
  const lines = gunzipSync(readFileSync(blocklistFile)).toString('utf8').split('\n');
  return new Set(lines.filter((line) => line.length > 0));
}

function wordsFrom(details: PersonalDetails): string[] {
  const words: string[] = [];
  const addWordsOf = (text: string | undefined, separators: RegExp) => {
    for (const word of (text ?? '').normalize('NFC').toLowerCase().split(separators)) {
      if (Array.from(word).length >= MINIMUM_PERSONAL_WORD_LENGTH) words.push(word);
    }
  };
  addWordsOf(details.fullName, /\s+/);
  const localPartOfEmail = (details.email ?? '').split('@')[0];
  addWordsOf(localPartOfEmail, /[._+\-]+/);
  if (localPartOfEmail && Array.from(localPartOfEmail).length >= MINIMUM_PERSONAL_WORD_LENGTH) {
    words.push(localPartOfEmail.normalize('NFC').toLowerCase());
  }
  for (const stationName of details.stationNames ?? []) addWordsOf(stationName, /[\s·.,]+/);
  return words;
}

function isRepetitiveOrSequential(characters: string[]): boolean {
  for (let unitLength = 1; unitLength <= LONGEST_REPEATED_UNIT; unitLength++) {
    if (characters.every((character, index) => character === characters[index % unitLength])) return true;
  }
  const codePoints = characters.map((character) => character.codePointAt(0) as number);
  const steps = codePoints.slice(1).map((codePoint, index) => codePoint - (codePoints[index] as number));
  return steps.every((step) => step === 1) || steps.every((step) => step === -1);
}
