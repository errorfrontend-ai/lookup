import type { ActionCard, AdCampaignSummary, AdDetail, AdHistoryEvent, AdListViewCounts, AdSchedule, AdSummary, StationOverview } from '@lookup/contracts';

let adCounter = 0;

/** A campaign that is on air every day from 07:00 to 09:00, for building ads in tests. */
export function campaignSummary(overrides: Partial<AdCampaignSummary> = {}): AdCampaignSummary {
  return {
    id: `0190f1a2-0000-7000-8000-00000000ca${String(++adCounter).padStart(2, '0')}`,
    displayStatus: 'LIVE_NOW',
    startsOn: '2026-10-01',
    endsOn: '2026-10-31',
    timeWindows: [{ daysOfWeek: [1, 2, 3, 4, 5], localStartTime: '07:00', localEndTime: '09:00' }],
    ...overrides,
  };
}

/** An ad as the API lists it: uploaded and checked, live now, no problems. Override what a test cares about. */
export function adSummary(overrides: Partial<AdSummary> = {}): AdSummary {
  const number = ++adCounter;
  return {
    id: `0190f1a2-0000-7000-8000-00000000ad${String(number).padStart(2, '0')}`,
    title: `Ad number ${number}`,
    client: { id: '0190f1a2-0000-7000-8000-0000000000a1', name: 'Brand A' },
    status: 'PROCESSING',
    durationMilliseconds: null,
    uploadedFileName: 'offer.mp3',
    campaign: campaignSummary(),
    hasActionCard: true,
    attentionReasons: [],
    updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

export function viewCounts(overrides: Partial<AdListViewCounts> = {}): AdListViewCounts {
  return { all: 0, live: 0, scheduled: 0, drafts: 0, attention: 0, ended: 0, ...overrides };
}

/** An overview for a set of ads: counts worked out from their own state. */
export function overviewFor(ads: AdSummary[]): StationOverview {
  const live = ads.filter((ad) => ad.campaign?.displayStatus === 'LIVE_NOW');
  const attention = ads.filter((ad) => ad.attentionReasons.length > 0);
  return {
    adCounts: viewCounts({
      all: ads.length,
      live: live.length,
      scheduled: ads.filter((ad) => ad.campaign?.displayStatus === 'SCHEDULED').length,
      drafts: ads.filter((ad) => !ad.campaign || ad.campaign.displayStatus === 'DRAFT').length,
      attention: attention.length,
      ended: ads.filter((ad) => ad.campaign?.displayStatus === 'ENDED').length,
    }),
    liveNowAds: live,
    attentionAds: attention,
  };
}

/** A valid card with a call, a WhatsApp and a directions button. */
export function actionCardFixture(): ActionCard {
  return {
    schema_version: 1,
    layout: 'VERTICAL_STACK',
    actions: [
      { type: 'CALL', id: '0190f1a2-0000-7000-8000-0000000000e1', label: 'Call Brand A', style: 'PRIMARY', phone_number_e164: '+260977123456' },
      { type: 'WHATSAPP', id: '0190f1a2-0000-7000-8000-0000000000e2', label: 'Chat on WhatsApp', style: 'SECONDARY', phone_number_e164: '+260966000111', prefilled_text: 'Hello there' },
      { type: 'MAP', id: '0190f1a2-0000-7000-8000-0000000000e3', label: 'Get directions', style: 'OUTLINE', latitude: -15.4167, longitude: 28.2833, place_name: 'Cairo Road, Lusaka' },
    ],
  } as ActionCard;
}

export function scheduleFixture(overrides: Partial<AdSchedule> = {}): AdSchedule {
  return { ...campaignSummary(), gracePeriodMinutes: 10, engagementLimit: null, stationTimeZone: 'Africa/Lusaka', ...overrides };
}

/** An ad as its own page shows it: the summary plus its buttons, schedule and upload facts. */
export function adDetail(overrides: Partial<AdDetail> = {}): AdDetail {
  const summary = adSummary();
  return {
    ...summary,
    uploadSizeBytes: 96_044,
    uploadedAt: new Date(Date.now() - 38 * 60 * 1000).toISOString(),
    processingErrorCode: null,
    actionCard: actionCardFixture(),
    schedule: scheduleFixture({ id: summary.campaign?.id ?? 'campaign' }),
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

let eventCounter = 0;
/** `Omit` for each member of a union, so every kind of event keeps its own fields. */
type DistributiveOmit<Type, Keys extends PropertyKey> = Type extends unknown ? Omit<Type, Keys> : never;

/** One history event, newest-first order is up to the test. */
export function historyEvent(event: DistributiveOmit<AdHistoryEvent, 'id' | 'occurredAt' | 'actorName'> & Partial<Pick<AdHistoryEvent, 'id' | 'occurredAt' | 'actorName'>>): AdHistoryEvent {
  return { id: String(1000 - ++eventCounter), occurredAt: new Date(Date.now() - eventCounter * 60 * 60 * 1000).toISOString(), actorName: 'Chanda Mwale', ...event } as AdHistoryEvent;
}
