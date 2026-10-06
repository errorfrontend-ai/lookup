import { Foundation1790960000000 } from './1790960000000-Foundation.js';
import { StationPortal1791100000000 } from './1791100000000-StationPortal.js';
import { UploadRefusalReasons1791150000000 } from './1791150000000-UploadRefusalReasons.js';
import { AdCardsAndSchedules1791200000000 } from './1791200000000-AdCardsAndSchedules.js';
import { DatabaseHardening1791300000000 } from './1791300000000-DatabaseHardening.js';
import { AdHistoryIndexes1791400000000 } from './1791400000000-AdHistoryIndexes.js';

/** Every migration, oldest first. The migration script runs these; the API never does. */
export const ALL_MIGRATIONS = [
  Foundation1790960000000,
  StationPortal1791100000000,
  UploadRefusalReasons1791150000000,
  AdCardsAndSchedules1791200000000,
  DatabaseHardening1791300000000,
  AdHistoryIndexes1791400000000,
];
