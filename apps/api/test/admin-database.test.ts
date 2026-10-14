import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ClsService } from 'nestjs-cls';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_DATA_SOURCE,
  AdminTransaction,
  assertDatabaseRoleIsTheAdminRole,
} from '../src/infrastructure/admin-database/admin-database.module.js';
import { databaseSetupClient, lookupApiClient } from './support/database-clients.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * The super admin's own connection (P5A design §3.1): it starts only as lookup_admin_api, and each unit of work names
 * the signed-in super admin (and the station worked on) for the audit trail.
 */
describe('the admin database connection', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  const rowsOf = (client: pg.Client) => ({ query: (sql: string) => client.query(sql).then((result) => result.rows) });

  beforeAll(async () => {
    testApplication = await createTestApplication();
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    await setupClient.connect();
    await apiClient.connect();
  });
  afterAll(async () => {
    await apiClient.end();
    await setupClient.end();
    await testApplication.close();
  });

  it('connects as lookup_admin_api, a pool of its own beside the API\'s', async () => {
    const adminSource = testApplication.application.get<DataSource>(getDataSourceToken(ADMIN_DATA_SOURCE));
    const apiSource = testApplication.application.get<DataSource>(getDataSourceToken());
    expect((await adminSource.query('SELECT current_user AS role_name'))[0].role_name).toBe('lookup_admin_api');
    expect((await apiSource.query('SELECT current_user AS role_name'))[0].role_name).toBe('lookup_api');
  });

  it('refuses to start as the API role, or as a superuser', async () => {
    await expect(assertDatabaseRoleIsTheAdminRole(rowsOf(apiClient))).rejects.toThrow(/must connect as lookup_admin_api \(role=lookup_api\)/);
    await expect(assertDatabaseRoleIsTheAdminRole(rowsOf(setupClient))).rejects.toThrow(/Refusing to start/);
  });

  it('a unit of work names the signed-in super admin and the station, for that transaction only', async () => {
    const userId = randomUUID();
    const stationId = randomUUID();
    const transaction = testApplication.application.get(AdminTransaction);
    const requestContext = testApplication.application.get(ClsService);
    const seen = await requestContext.run(async () => {
      requestContext.set('userId', userId);
      return transaction.run(
        async (database) => (await database.query(`SELECT app.current_user_id() AS user_id, app.current_station_id() AS station_id`))[0],
        { stationId },
      );
    });
    expect(seen).toEqual({ user_id: userId, station_id: stationId });
    const adminSource = testApplication.application.get<DataSource>(getDataSourceToken(ADMIN_DATA_SOURCE));
    expect((await adminSource.query(`SELECT app.current_user_id() AS user_id`))[0].user_id).toBeNull();
  });
});
