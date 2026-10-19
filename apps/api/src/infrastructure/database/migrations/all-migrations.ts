import { Foundation1790960000000 } from './1790960000000-Foundation.js';
import { StationPortal1791100000000 } from './1791100000000-StationPortal.js';
import { UploadRefusalReasons1791150000000 } from './1791150000000-UploadRefusalReasons.js';
import { AdCardsAndSchedules1791200000000 } from './1791200000000-AdCardsAndSchedules.js';
import { DatabaseHardening1791300000000 } from './1791300000000-DatabaseHardening.js';
import { AdHistoryIndexes1791400000000 } from './1791400000000-AdHistoryIndexes.js';
import { EngineHookup1791500000000 } from './1791500000000-EngineHookup.js';
import { StationResolution1791600000000 } from './1791600000000-StationResolution.js';
import { FingerprintVersionTwo1791700000000 } from './1791700000000-FingerprintVersionTwo.js';
import { RegistrationAndAdmin1791800000000 } from './1791800000000-RegistrationAndAdmin.js';
import { ListenerAccounts1791900000000 } from './1791900000000-ListenerAccounts.js';

/** Every migration, oldest first. The migration script runs these; the API never does. */
export const ALL_MIGRATIONS = [
  Foundation1790960000000,
  StationPortal1791100000000,
  UploadRefusalReasons1791150000000,
  AdCardsAndSchedules1791200000000,
  DatabaseHardening1791300000000,
  AdHistoryIndexes1791400000000,
  EngineHookup1791500000000,
  StationResolution1791600000000,
  FingerprintVersionTwo1791700000000,
  RegistrationAndAdmin1791800000000,
  ListenerAccounts1791900000000,
];
