import { getDataSourceToken } from '@nestjs/typeorm';
import supertest from 'supertest';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { waitForLogWrites } from './support/log-capture.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/** S1-TESTS-02, S1-HEALTH-02: health with the database unreachable (the API started while it was up). */
describe('health when the database is down', () => {
  let testApplication: TestApplication;

  beforeAll(async () => {
    testApplication = await createTestApplication();
    const dataSource = testApplication.application.get<DataSource>(getDataSourceToken());
    const realQuery = dataSource.query.bind(dataSource);
    dataSource.query = ((...queryArguments: Parameters<DataSource['query']>) =>
      queryArguments[0] === 'SELECT 1'
        ? Promise.reject(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:55432'), { code: 'ECONNREFUSED' }))
        : realQuery(...queryArguments)) as DataSource['query'];
  });
  afterAll(async () => testApplication.close());

  it('returns a generic 503 with a request id, and logs which dependency failed, with the stack', async () => {
    const response = await supertest(testApplication.application.getHttpServer()).get('/api/v1/health').expect(503);
    const envelope = assertErrorEnvelope(response.body);
    expect(envelope.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(envelope.error.request_id).toBe(response.headers['x-request-id']);
    expect(JSON.stringify(response.body)).not.toMatch(/ECONNREFUSED|55432|database/i);

    await waitForLogWrites();
    const logLine = testApplication.logs.find((line) => line.requestId === envelope.error.request_id && line.code === 'SERVICE_UNAVAILABLE');
    expect(logLine?.detail).toBe('health: database=rejected key_value_store=fulfilled');
    expect(JSON.stringify(logLine?.err)).toMatch(/ECONNREFUSED[\s\S]*stack/);
  });
});
