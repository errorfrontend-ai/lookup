import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { AppError } from '../../common/errors/app-error.js';

/**
 * argon2id at an OWASP-recommended setting (19 MiB, 2 passes, 1 lane). The package defaults (64 MiB,
 * 4 lanes) would let four sign-ins at once take about 256 MiB of a 512 MB instance.
 */
export const PASSWORD_HASHING_PARAMETERS = { memoryCost: 19_456, timeCost: 2, parallelism: 1, hashLength: 32 } as const;

const MAXIMUM_CONCURRENT_HASHES = 2;
const MAXIMUM_WAIT_FOR_A_HASHING_SLOT_MILLISECONDS = 2_000;
// The parameters are named (m, t, p); the argon2 package writes them as m,p,t, so read them in any order.
const STORED_SETTINGS_PATTERN = /^\$argon2id\$v=19\$([mtp]=\d+,[mtp]=\d+,[mtp]=\d+)\$([A-Za-z0-9+/]+)\$$/;

interface HashSettings {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
  salt: Buffer;
}

/**
 * Computes argon2id hashes. The stored hash never reaches the API: the database hands over only the
 * settings (algorithm, parameters, salt), the API computes the hash the submitted password would have,
 * and the database compares. Passwords are NFC-normalised first, so the same characters typed on
 * different keyboards give the same hash.
 *
 * At most two hashes run at once per instance; a request that can't get a slot within 2 seconds is
 * answered with SERVICE_UNAVAILABLE rather than piling up memory.
 */
@Injectable()
export class PasswordHasher {
  private activeHashCount = 0;
  private readonly waitingForSlot: Array<{ start: () => void }> = [];
  /** Settings for emails with no account, so an unknown email costs exactly as much as a real one. */
  private readonly settingsForUnknownAccounts = formatSettings({
    ...PASSWORD_HASHING_PARAMETERS,
    salt: randomBytes(16),
  });

  /** A new hash with a fresh salt and the current parameters. */
  hashNewPassword(password: string): Promise<string> {
    return this.withHashingSlot(() =>
      argon2.hash(password.normalize('NFC'), { type: argon2.argon2id, ...PASSWORD_HASHING_PARAMETERS }),
    );
  }

  /** The hash `password` would have under the stored settings (or throwaway settings when there is no account). */
  computeWithStoredSettings(password: string, storedSettings: string | null): Promise<string> {
    const settings = parseSettings(storedSettings ?? '') ?? (parseSettings(this.settingsForUnknownAccounts) as HashSettings);
    return this.withHashingSlot(() =>
      argon2.hash(password.normalize('NFC'), {
        type: argon2.argon2id,
        memoryCost: settings.memoryCost,
        timeCost: settings.timeCost,
        parallelism: settings.parallelism,
        hashLength: PASSWORD_HASHING_PARAMETERS.hashLength,
        salt: settings.salt,
      }),
    );
  }

  /** True when the stored hash used other parameters than today's, so it should be replaced at the next sign-in. */
  needsRehash(storedSettings: string): boolean {
    const settings = parseSettings(storedSettings);
    return (
      !settings ||
      settings.memoryCost !== PASSWORD_HASHING_PARAMETERS.memoryCost ||
      settings.timeCost !== PASSWORD_HASHING_PARAMETERS.timeCost ||
      settings.parallelism !== PASSWORD_HASHING_PARAMETERS.parallelism
    );
  }

  private async withHashingSlot<Result>(work: () => Promise<Result>): Promise<Result> {
    await this.waitForHashingSlot();
    try {
      return await work();
    } finally {
      this.activeHashCount--;
      this.waitingForSlot.shift()?.start();
    }
  }

  private waitForHashingSlot(): Promise<void> {
    if (this.activeHashCount < MAXIMUM_CONCURRENT_HASHES) {
      this.activeHashCount++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        start: () => {
          clearTimeout(giveUpTimer);
          this.activeHashCount++;
          resolve();
        },
      };
      const giveUpTimer = setTimeout(() => {
        this.waitingForSlot.splice(this.waitingForSlot.indexOf(waiter), 1);
        reject(new AppError('SERVICE_UNAVAILABLE', { internalDetail: 'password hashing is at capacity' }));
      }, MAXIMUM_WAIT_FOR_A_HASHING_SLOT_MILLISECONDS);
      this.waitingForSlot.push(waiter);
    });
  }
}

function parseSettings(storedSettings: string): HashSettings | null {
  const match = STORED_SETTINGS_PATTERN.exec(storedSettings);
  if (!match) return null;
  const [, parameterList, saltBase64] = match as unknown as [string, string, string];
  const parameters = Object.fromEntries(parameterList.split(',').map((parameter) => parameter.split('=') as [string, string]));
  if (!parameters.m || !parameters.t || !parameters.p) return null;
  return {
    memoryCost: Number(parameters.m),
    timeCost: Number(parameters.t),
    parallelism: Number(parameters.p),
    salt: Buffer.from(saltBase64, 'base64'),
  };
}

function formatSettings(settings: HashSettings): string {
  const saltBase64 = settings.salt.toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=${settings.memoryCost},t=${settings.timeCost},p=${settings.parallelism}$${saltBase64}$`;
}
