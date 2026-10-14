import { Global, Module } from '@nestjs/common';

/**
 * What time it is, for the rules a test must be able to move: when a phone code expires and when another may be sent
 * (P5A design §3.1). The database's own now() cannot be faked, so rules it keeps are tested by moving stored times.
 */
export interface Clock {
  now(): Date;
}

/** Dependency-injection token for the clock. */
export const CLOCK = Symbol('CLOCK');

export const SYSTEM_CLOCK: Clock = { now: () => new Date() };

@Global()
@Module({ providers: [{ provide: CLOCK, useValue: SYSTEM_CLOCK }], exports: [CLOCK] })
export class ClockModule {}
