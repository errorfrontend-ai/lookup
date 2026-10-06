import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ActionCard } from '@lookup/contracts';
import type pg from 'pg';
import { createSampleJingleWav } from './sample-audio.js';

export interface SampleStorage {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

interface SampleCampaign {
  status: 'DRAFT' | 'ACTIVE' | 'ENDED';
  /** First and last day it airs, in days from today in the station's time zone (negative: in the past). */
  startsInDays: number;
  endsInDays: number;
  /** ISO days (1 = Monday) and the local hours each window covers. */
  windows: Array<{ days: number[]; from: string; to: string }>;
}

interface SampleAd {
  title: string;
  clientName: string;
  /** How long ago the ad was last changed, so the list has a believable order. */
  changedHoursAgo: number;
  uploadState: 'checked' | 'refused';
  hasButtons: boolean;
  campaign?: SampleCampaign;
}

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
const SAMPLE_PHONE = '+260977123456';

/** Ads in every state the portal shows, so a developer sees each badge, tab and warning at once. */
const SAMPLE_ADS: SampleAd[] = [
  { title: 'Summer service offer', clientName: 'Brand A', changedHoursAgo: 2, uploadState: 'checked', hasButtons: true, campaign: { status: 'ACTIVE', startsInDays: -10, endsInDays: 20, windows: [{ days: EVERY_DAY, from: '05:00', to: '23:00' }] } },
  { title: 'Harvest festival', clientName: 'Brand B', changedHoursAgo: 5, uploadState: 'checked', hasButtons: true, campaign: { status: 'ACTIVE', startsInDays: -20, endsInDays: 1, windows: [{ days: EVERY_DAY, from: '05:00', to: '23:00' }] } },
  { title: 'Weekend sale', clientName: 'Brand B', changedHoursAgo: 26, uploadState: 'checked', hasButtons: true, campaign: { status: 'ACTIVE', startsInDays: 3, endsInDays: 28, windows: [{ days: [6, 7], from: '10:00', to: '14:00' }] } },
  { title: 'New menu launch', clientName: 'Brand A', changedHoursAgo: 30, uploadState: 'checked', hasButtons: true, campaign: { status: 'DRAFT', startsInDays: -2, endsInDays: 20, windows: [{ days: [1, 2, 3, 4, 5], from: '07:00', to: '09:00' }, { days: [1, 2, 3, 4, 5], from: '17:00', to: '19:00' }] } },
  { title: 'Back to school offer', clientName: 'Brand A', changedHoursAgo: 50, uploadState: 'checked', hasButtons: false },
  { title: 'Festive greetings', clientName: 'Brand B', changedHoursAgo: 72, uploadState: 'refused', hasButtons: false },
  { title: 'Spring promo', clientName: 'Brand A', changedHoursAgo: 24 * 14, uploadState: 'checked', hasButtons: true, campaign: { status: 'ENDED', startsInDays: -45, endsInDays: -15, windows: [{ days: [1, 2, 3, 4, 5], from: '17:00', to: '19:00' }] } },
];

function buttonsFor(clientName: string): ActionCard {
  return ActionCard.parse({
    schema_version: 1,
    layout: 'VERTICAL_STACK',
    actions: [
      { type: 'CALL', id: randomUUID(), label: `Call ${clientName}`, style: 'PRIMARY', phone_number_e164: SAMPLE_PHONE },
      { type: 'WHATSAPP', id: randomUUID(), label: 'Chat on WhatsApp', style: 'SECONDARY', phone_number_e164: SAMPLE_PHONE, prefilled_text: `Hi ${clientName}, I heard your ad on the radio.` },
      { type: 'MAP', id: randomUUID(), label: 'Get directions', style: 'OUTLINE', latitude: -15.4167, longitude: 28.2833, place_name: 'Cairo Road, Lusaka' },
    ],
  });
}


/**
 * The audit rows the API would have written as each sample ad was made, so an ad's history reads like a
 * real one: created, audio checked, buttons added, schedule set, published. Spread over the days since
 * the ad was last changed, oldest first.
 */
async function recordSampleHistory(client: pg.Client, stationId: string, ownerId: string, adId: string, sample: SampleAd, cardId: string | null, audioBytes: number): Promise<void> {
  const record = async (minutesAfterCreation: number, action: string, entityType: string, entityId: string, changes: Record<string, unknown>) =>
    client.query(
      `INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'development-seed', now() - $7 * interval '1 hour' + $8 * interval '1 minute')`,
      [stationId, ownerId, action, entityType, entityId, JSON.stringify(changes), sample.changedHoursAgo + 1, minutesAfterCreation],
    );
  await record(0, 'ad_created', 'ad', adId, { title: sample.title, upload: { fileName: `${sample.title}.wav`, contentType: 'audio/wav', sizeBytes: audioBytes } });
  if (sample.uploadState === 'refused') {
    await record(1, 'ad_upload_refused', 'ad', adId, { reason: 'not_the_declared_audio_format' });
    return;
  }
  await record(1, 'ad_upload_verified', 'ad', adId, { sizeBytes: audioBytes, contentType: 'audio/wav' });
  if (cardId) {
    const savedCard = (await client.query(`SELECT content FROM app.action_cards WHERE id = $1`, [cardId])).rows[0].content as ActionCard;
    const actionIds = savedCard.actions.map((action) => action.id);
    await record(5, 'action_card_saved', 'action_card', cardId, {
      adId,
      previousActionCardId: null,
      changedFields: [{ path: 'schema_version', change: 'added' }, { path: 'layout', change: 'added' }, ...actionIds.map((actionId) => ({ path: `actions.${actionId}`, change: 'added' }))],
    });
  }
  const campaign = (await client.query(`SELECT id FROM app.campaigns WHERE ad_id = $1`, [adId])).rows[0] as { id: string } | undefined;
  if (campaign && sample.campaign) {
    await record(10, 'campaign_schedule_saved', 'campaign', campaign.id, { adId, previousSchedule: null, schedule: { windows: sample.campaign.windows.length } });
    if (sample.campaign.status !== 'DRAFT') await record(12, 'campaign_published', 'campaign', campaign.id, { adId, previousStatus: 'DRAFT', previousActionCardId: null, actionCardId: cardId });
  }
}

/**
 * Adds the sample ads to the station if they are not there yet (matched by title, so running it again
 * adds nothing). Audio goes to the development object storage; the ads then look uploaded and checked.
 * Returns how many ads it created.
 */
export async function seedSampleAds(
  client: pg.Client,
  stationId: string,
  storage: SampleStorage,
  ownerId: string,
): Promise<number> {
  const clientIds = new Map<string, string>(
    (await client.query(`SELECT id, name FROM app.clients WHERE station_id = $1`, [stationId])).rows.map((row) => [row.name as string, row.id as string]),
  );
  const storageClient = new S3Client({
    endpoint: storage.endpoint,
    region: storage.region,
    forcePathStyle: true,
    credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const jingle = createSampleJingleWav();
  let createdCount = 0;
  try {
    for (const sample of SAMPLE_ADS) {
      const clientId = clientIds.get(sample.clientName);
      if (!clientId) continue;
      const existing = await client.query(`SELECT 1 FROM app.ads WHERE station_id = $1 AND title = $2`, [stationId, sample.title]);
      if (existing.rowCount) continue;

      const adId = randomUUID();
      const objectKey = `ad-uploads/${stationId}/${adId}/sample`;
      const isChecked = sample.uploadState === 'checked';
      if (isChecked) {
        await storageClient.send(new PutObjectCommand({ Bucket: storage.bucket, Key: objectKey, Body: jingle, ContentType: 'audio/wav' }));
      }
      let cardId: string | null = null;
      if (sample.hasButtons) {
        cardId = randomUUID();
        await client.query(
          `INSERT INTO app.action_cards (id, station_id, client_id, schema_version, content) VALUES ($1, $2, $3, 1, $4::jsonb)`,
          [cardId, stationId, clientId, JSON.stringify(buttonsFor(sample.clientName))],
        );
      }
      await client.query(
        `INSERT INTO app.ads (id, station_id, client_id, title, status, upload_object_key, upload_content_type, upload_size_bytes,
                              upload_original_file_name, uploaded_at, processing_error_code, current_action_card_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now() - $13 * interval '1 hour', now() - $13 * interval '1 hour')`,
        [
          adId, stationId, clientId, sample.title, isChecked ? 'PROCESSING' : 'FAILED',
          isChecked ? objectKey : null, isChecked ? 'audio/wav' : null, isChecked ? jingle.length : null,
          isChecked ? `${sample.title.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.wav` : null,
          isChecked ? new Date() : null, isChecked ? null : 'not_the_declared_audio_format', cardId, sample.changedHoursAgo,
        ],
      );
      if (sample.campaign) {
        const campaignId = randomUUID();
        await client.query(
          `INSERT INTO app.campaigns (id, station_id, ad_id, name, status, action_card_id, active_period, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6,
                   tstzrange((((now() AT TIME ZONE 'Africa/Lusaka')::date + $7::integer)::timestamp) AT TIME ZONE 'Africa/Lusaka',
                             (((now() AT TIME ZONE 'Africa/Lusaka')::date + $8::integer + 1)::timestamp) AT TIME ZONE 'Africa/Lusaka', '[)'),
                   now() - $9 * interval '1 hour')`,
          [campaignId, stationId, adId, sample.title, sample.campaign.status, sample.campaign.status === 'DRAFT' ? null : cardId,
           sample.campaign.startsInDays, sample.campaign.endsInDays, sample.changedHoursAgo],
        );
        for (const window of sample.campaign.windows) {
          await client.query(
            `INSERT INTO app.campaign_time_windows (campaign_id, station_id, days_of_week, local_start_time, local_end_time)
             VALUES ($1, $2, $3::smallint[], $4::time, $5::time)`,
            [campaignId, stationId, window.days, window.from, window.to],
          );
        }
      }
      await recordSampleHistory(client, stationId, ownerId, adId, sample, cardId, jingle.length);
      createdCount += 1;
    }
  } finally {
    storageClient.destroy();
  }
  return createdCount;
}

export const SAMPLE_AD_TITLES = SAMPLE_ADS.map((sample) => sample.title);
