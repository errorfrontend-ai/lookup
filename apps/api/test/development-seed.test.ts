import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDevelopmentData } from '../scripts/seed-development-data.js';
import { databaseSetupClient } from './support/database-clients.js';

describe('development seed', () => {
  let setupClient: pg.Client;
  const runTag = randomUUID().slice(0, 8);
  const seed = {
    stationName: `Seed Station ${runTag}`,
    frequencyLabel: '98.1 FM',
    ownerEmail: `seed-owner-${runTag}@example.test`,
    // Not containing the run tag: it is part of the station name, which the policy rightly refuses.
    ownerPassword: 'amber kettle rainy harbour 7461',
    ownerFullName: 'Seed Owner',
    clientNames: ['Brand A', 'Brand B'],
  };

  beforeAll(async () => {
    setupClient = databaseSetupClient();
    await setupClient.connect();
  });
  afterAll(async () => {
    const station = await setupClient.query(`SELECT id FROM app.stations WHERE name = $1`, [seed.stationName]);
    const stationIds = station.rows.map((row) => row.id);
    await setupClient.query('DELETE FROM app.clients WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.station_memberships WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.portal_users WHERE email = $1', [seed.ownerEmail]);
    await setupClient.query('DELETE FROM app.stations WHERE id = ANY($1)', [stationIds]);
    await setupClient.end();
  });

  it('creates an active station, its owner and two clients, and running it again changes nothing', async () => {
    const setupUrl = process.env.DATABASE_SETUP_URL as string;
    const first = await seedDevelopmentData(setupUrl, seed);
    const second = await seedDevelopmentData(setupUrl, seed);
    expect(second).toEqual(first);
    const counts = await setupClient.query(
      `SELECT (SELECT count(*) FROM app.stations WHERE name = $1)::integer AS stations,
              (SELECT status FROM app.stations WHERE id = $2) AS station_status,
              (SELECT count(*) FROM app.clients WHERE station_id = $2)::integer AS clients,
              (SELECT role FROM app.station_memberships WHERE station_id = $2 AND portal_user_id = $3) AS role,
              (SELECT password_hash FROM app.portal_users WHERE id = $3) AS password_hash`,
      [seed.stationName, first.stationId, first.ownerId],
    );
    expect(counts.rows[0]).toMatchObject({ stations: 1, station_status: 'ACTIVE', clients: 2, role: 'OWNER' });
    expect(counts.rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });

  it('refuses a weak owner password and refuses to run in production', async () => {
    const setupUrl = process.env.DATABASE_SETUP_URL as string;
    await expect(seedDevelopmentData(setupUrl, { ...seed, ownerPassword: 'short' })).rejects.toThrow(/too_short/);
    const previousEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(seedDevelopmentData(setupUrl, seed)).rejects.toThrow(/Refusing to seed development data in production/);
    } finally {
      process.env.NODE_ENV = previousEnvironment;
    }
  });
});
