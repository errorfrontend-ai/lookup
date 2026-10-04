import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Local runs read apps/api/.env; CI provides real environment variables (which take precedence,
// because loadEnvFile never overwrites a variable that is already set).
const environmentFile = resolve(import.meta.dirname, '..', '..', '.env');
if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);
process.env.NODE_ENV = 'test';
