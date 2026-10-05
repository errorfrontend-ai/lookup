// A tiny process with the API's real failure handlers installed, which then fails in the way named
// by its first argument. Started by test/process-failures.test.ts; never part of the application.
import { installProcessFailureHandlers } from '../../src/process-failures.js';

installProcessFailureHandlers();

const personalValue = 'chanda.mwale@example.test';
const failure = process.argv[2];
if (failure === 'unhandled-rejection') {
  void Promise.reject(new Error(`nobody awaited the lookup for ${personalValue}`));
} else if (failure === 'uncaught-exception') {
  setTimeout(() => {
    throw new TypeError(`nothing caught the failure for ${personalValue}`);
  }, 0);
} else {
  throw new Error(`unknown failure: ${failure}`);
}
