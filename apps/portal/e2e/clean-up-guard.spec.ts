import { expect, test } from '@playwright/test';
import { cleanUpIsAllowed } from './support/remove-browser-test-ads';

test('the browser-test clean-up runs only against a development database on this computer', () => {
  expect(cleanUpIsAllowed('postgres://setup:secret@localhost:55432/lookup', 'development')).toBe(true);
  expect(cleanUpIsAllowed('postgres://setup:secret@127.0.0.1:55432/lookup', undefined)).toBe(true);
  expect(cleanUpIsAllowed('postgres://setup:secret@lookup-db.frankfurt-postgres.render.com:5432/lookup', 'development')).toBe(false);
  expect(cleanUpIsAllowed('postgres://setup:secret@localhost:55432/lookup', 'production')).toBe(false);
  expect(cleanUpIsAllowed('not an address', 'development')).toBe(false);
});
