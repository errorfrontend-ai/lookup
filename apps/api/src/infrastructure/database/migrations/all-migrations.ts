import { Foundation1790960000000 } from './1790960000000-Foundation.js';
import { StationPortal1791100000000 } from './1791100000000-StationPortal.js';

/** Every migration, oldest first. The migration script runs these; the API never does. */
export const ALL_MIGRATIONS = [Foundation1790960000000, StationPortal1791100000000];
