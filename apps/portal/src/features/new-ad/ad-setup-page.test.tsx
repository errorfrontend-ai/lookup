import type { AdDetail, ClientListItem, UploadInstructions } from '@lookup/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { actionCardFixture, adDetail, campaignSummary, overviewFor, scheduleFixture } from '../../test/ad-fixtures';
import { errorResponse, INTERNAL_DETAIL_PATTERN, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { renderPortalAt } from '../../test/render-portal';
import { clearAllUploads, replaceStorageTransport } from './ad-upload-store';
import { StorageNetworkError, type StorageTransport, StorageUploadCancelled } from './send-file-to-storage';

const person = userEvent.setup({ delay: null });
const personWhoMayChooseAnyFile = userEvent.setup({ delay: null, applyAccept: false });
const owner = signedInUserWith([{ role: 'OWNER' }]);
const stationId = owner.stations[0]?.id as string;
const adId = '0190f1a2-0000-7000-8000-00000000ad77';

const brandA: ClientListItem = { id: '0190f1a2-0000-7000-8000-0000000000a1', name: 'Brand A', adCount: 3, liveNowAdCount: 1 };
const brandB: ClientListItem = { id: '0190f1a2-0000-7000-8000-0000000000b2', name: 'Brand B', adCount: 0, liveNowAdCount: 0 };

const uploadInstructions: UploadInstructions = {
  method: 'PUT',
  url: 'https://storage.test/signed-address',
  headers: { 'Content-Type': 'audio/mpeg' },
  expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
};

function audioFile(name = 'summer_offer.mp3', type = 'audio/mpeg'): File {
  return new File([new Uint8Array(2_048)], name, { type });
}

/** The ad as the API has it just after creation, before its audio has arrived. */
function newDraft(overrides: Partial<AdDetail> = {}): AdDetail {
  return adDetail({
    id: adId,
    title: 'Summer service offer',
    client: { id: brandA.id, name: brandA.name },
    status: 'AWAITING_UPLOAD',
    uploadedFileName: 'summer_offer.mp3',
    uploadSizeBytes: 2_048,
    uploadedAt: null,
    actionCard: null,
    schedule: null,
    campaign: null,
    ...overrides,
  });
}

let restoreTransport: () => void = () => undefined;
let transportCalls: Parameters<StorageTransport>[0][] = [];

function useTransport(transport: StorageTransport = async ({ onProgress }) => {
  onProgress(0.5);
  return { status: 200 };
}) {
  restoreTransport = replaceStorageTransport(async (request) => {
    transportCalls.push(request);
    return transport(request);
  });
}

beforeEach(() => {
  transportCalls = [];
  useTransport();
});

afterEach(() => {
  restoreTransport();
  clearAllUploads();
  queryClient.clear();
  vi.unstubAllGlobals();
});

interface SetupOptions {
  user?: ReturnType<typeof signedInUserWith>;
  clients?: ClientListItem[];
  /** The ad the API holds, when the test starts from an existing draft. */
  draft?: AdDetail;
  extra?: Parameters<typeof installFakeApi>[0];
}

/** The fake API for setting up an ad. Once the file is checked the ad reads as PROCESSING, as the real one does. */
function installSetup({ user = owner, clients = [brandA, brandB], draft = newDraft(), extra = {} }: SetupOptions = {}) {
  const sessionStationId = user.stations[0]?.id as string;
  let current = draft;
  return installFakeApi({
    'GET /auth/me': () => jsonResponse(200, user),
    [`GET /stations/${sessionStationId}/clients`]: () => jsonResponse(200, clients),
    [`GET /stations/${sessionStationId}/overview`]: () => jsonResponse(200, overviewFor([])),
    [`GET /stations/${sessionStationId}/ads`]: () => jsonResponse(200, { ads: [], nextCursor: null }),
    [`POST /stations/${sessionStationId}/ads`]: () => jsonResponse(201, { adId, upload: uploadInstructions }),
    [`GET /stations/${sessionStationId}/ads/${adId}`]: () => jsonResponse(200, current),
    [`POST /stations/${sessionStationId}/ads/${adId}/upload-url`]: () => jsonResponse(200, { ...uploadInstructions, url: 'https://storage.test/second-address' }),
    [`POST /stations/${sessionStationId}/ads/${adId}/complete`]: () => {
      current = { ...current, status: 'PROCESSING', uploadedAt: new Date().toISOString() };
      return jsonResponse(200, current);
    },
    ...extra,
  });
}

async function chooseClientAndContinue(name: RegExp) {
  await person.click(await screen.findByRole('radio', { name }));
  await person.click(screen.getByRole('button', { name: 'Next: Audio' }));
}

describe('Setting up an ad', () => {
  describe('step 1: who the ad is for', () => {
    it('lists the clients and only goes on once one is chosen', async () => {
      installSetup();
      renderPortalAt(`/stations/${stationId}/ads/new`);

      expect(await screen.findByRole('heading', { level: 1, name: 'Who is this ad for?' })).toBeInTheDocument();
      expect(screen.getByText('Step 1 of 5 · Client')).toBeInTheDocument();
      expect(screen.getByText('Nothing saved yet')).toBeInTheDocument();
      const next = screen.getByRole('button', { name: 'Next: Audio' });
      expect(next).toBeDisabled();

      await person.click(await screen.findByRole('radio', { name: /Brand B/ }));
      expect(next).toBeEnabled();
      await person.click(next);
      expect(await screen.findByRole('heading', { level: 1, name: 'Upload the ad' })).toBeInTheDocument();
      expect(screen.getByText(/For/)).toHaveTextContent('For Brand B');
    });

    it('adds a new client right there and chooses it', async () => {
      const { calls } = installSetup({
        clients: [brandA],
        extra: { [`POST /stations/${stationId}/clients`]: () => jsonResponse(201, { id: '0190f1a2-0000-7000-8000-0000000000c3', name: 'Brand C' }) },
      });
      renderPortalAt(`/stations/${stationId}/ads/new`);

      await person.click(await screen.findByRole('button', { name: '+ New client' }));
      await person.type(screen.getByLabelText("New client's name"), 'Brand C');
      await person.click(screen.getByRole('button', { name: 'Add client' }));

      await waitFor(() => expect(calls.find((call) => call.method === 'POST' && call.path.endsWith('/clients'))?.body).toEqual({ name: 'Brand C' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Next: Audio' })).toBeEnabled());
    });

    it('offers the existing client when the name is taken', async () => {
      installSetup({
        clients: [brandA],
        extra: { [`POST /stations/${stationId}/clients`]: () => errorResponse(409, 'CONFLICT', 'You already have a client called "Brand A".') },
      });
      renderPortalAt(`/stations/${stationId}/ads/new`);

      await person.click(await screen.findByRole('button', { name: '+ New client' }));
      await person.type(screen.getByLabelText("New client's name"), 'brand a');
      await person.click(screen.getByRole('button', { name: 'Add client' }));
      await person.click(await screen.findByRole('button', { name: /Use the existing/ }));

      expect(screen.getByRole('radio', { name: /Brand A/ })).toBeChecked();
    });
  });

  describe('step 2: the audio', () => {
    it('checks the file, names the ad from it, creates the draft and uploads, showing each stage', async () => {
      const { calls } = installSetup();
      const { router } = renderPortalAt(`/stations/${stationId}/ads/new`);

      await chooseClientAndContinue(/Brand A/);
      const uploadButton = screen.getByRole('button', { name: 'Upload ad' });
      expect(uploadButton).toBeDisabled();
      expect(within(screen.getByRole('banner')).getByText('Untitled ad')).toBeInTheDocument();

      const file = audioFile();
      await person.upload(screen.getByLabelText('Audio file'), file);
      const title = await screen.findByLabelText('Ad title');
      expect(title).toHaveValue('Summer offer');
      // The header follows the title as it is typed.
      expect(within(screen.getByRole('banner')).getByText('Summer offer')).toBeInTheDocument();
      expect(uploadButton).toBeEnabled();

      await person.clear(title);
      await person.type(title, 'Summer service offer');
      await person.click(uploadButton);

      expect(await screen.findByRole('heading', { level: 1, name: 'Your audio' })).toBeInTheDocument();
      expect(router.state.location.pathname).toBe(`/stations/${stationId}/ads/${adId}/setup`);
      expect(router.state.location.search).toBe('?step=audio');

      expect(calls.find((call) => call.method === 'POST' && call.path === `/stations/${stationId}/ads`)?.body).toEqual({
        clientId: brandA.id,
        title: 'Summer service offer',
        upload: { fileName: 'summer_offer.mp3', contentType: 'audio/mpeg', sizeBytes: file.size },
      });
      await waitFor(() => expect(transportCalls).toHaveLength(1));
      expect(transportCalls[0]).toMatchObject({ url: uploadInstructions.url, contentType: 'audio/mpeg', file });

      const progress = await screen.findByRole('list', { name: 'Upload progress' });
      await waitFor(() => expect(within(progress).getByText('Uploaded')).toBeInTheDocument());
      expect(within(progress).getByText('Checked')).toBeInTheDocument();
      expect(within(progress).getByText('Not prepared for recognition yet')).toBeInTheDocument();
      expect(within(progress).getByText(/once Look Up's recognition service is switched on/)).toBeInTheDocument();
      expect(screen.getByText('Draft saved')).toBeInTheDocument();
      expect(calls.filter((call) => call.path.endsWith('/complete'))).toHaveLength(1);
    });

    it('turns away a file that is not audio before anything is created', async () => {
      const { calls } = installSetup();
      renderPortalAt(`/stations/${stationId}/ads/new`);

      await chooseClientAndContinue(/Brand A/);
      await personWhoMayChooseAnyFile.upload(screen.getByLabelText('Audio file'), audioFile('notes.txt', 'text/plain'));

      expect(await screen.findByText('Choose an MP3, WAV or M4A audio file.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Upload ad' })).toBeDisabled();
      expect(screen.queryByLabelText('Ad title')).not.toBeInTheDocument();
      expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('/ads'))).toBe(false);

      await person.click(screen.getByRole('button', { name: 'Choose a different file' }));
      expect(screen.getByRole('button', { name: 'Choose an audio file' })).toBeInTheDocument();
    });

    it('will not create an ad with a blank title', async () => {
      installSetup();
      renderPortalAt(`/stations/${stationId}/ads/new`);
      await chooseClientAndContinue(/Brand A/);
      await person.upload(screen.getByLabelText('Audio file'), audioFile());

      const title = await screen.findByLabelText('Ad title');
      await person.clear(title);
      expect(screen.getByText('Give the ad a title.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Upload ad' })).toBeDisabled();
    });

    it('keeps the chosen file and title when the person goes Back to change the client', async () => {
      installSetup();
      renderPortalAt(`/stations/${stationId}/ads/new`);
      await chooseClientAndContinue(/Brand A/);
      await person.upload(screen.getByLabelText('Audio file'), audioFile());
      await screen.findByLabelText('Ad title');

      await person.click(screen.getByRole('button', { name: 'Back' }));
      await person.click(await screen.findByRole('radio', { name: /Brand B/ }));
      await person.click(screen.getByRole('button', { name: 'Next: Audio' }));

      expect(await screen.findByLabelText('Ad title')).toHaveValue('Summer offer');
      expect(screen.getByText('summer_offer.mp3')).toBeInTheDocument();
      expect(screen.getByText(/For/)).toHaveTextContent('For Brand B');
    });

    it('says in plain words, with the reference, when the ad cannot be created, and sends nothing to storage', async () => {
      installSetup({ extra: { [`POST /stations/${stationId}/ads`]: () => errorResponse(500, 'INTERNAL', 'Something went wrong on our side. Please try again.', 'ref-7788') } });
      renderPortalAt(`/stations/${stationId}/ads/new`);
      await chooseClientAndContinue(/Brand A/);
      await person.upload(screen.getByLabelText('Audio file'), audioFile());
      await screen.findByLabelText('Ad title');
      await person.click(screen.getByRole('button', { name: 'Upload ad' }));

      const notice = (await screen.findByText("We couldn't create the ad.")).closest('[role="alert"]') as HTMLElement;
      expect(notice).toHaveTextContent('ref-7788');
      expect(document.body.textContent).not.toMatch(INTERNAL_DETAIL_PATTERN);
      expect(transportCalls).toHaveLength(0);
      expect(screen.getByText('Nothing saved yet')).toBeInTheDocument();
    });

    it('tells the person when the chosen client no longer exists', async () => {
      installSetup({ extra: { [`POST /stations/${stationId}/ads`]: () => errorResponse(400, 'VALIDATION_FAILED', 'Please check the details.', 'ref-1', [{ path: 'clientId', code: 'unknown_client' }]) } });
      renderPortalAt(`/stations/${stationId}/ads/new`);
      await chooseClientAndContinue(/Brand A/);
      await person.upload(screen.getByLabelText('Audio file'), audioFile());
      await screen.findByLabelText('Ad title');
      await person.click(screen.getByRole('button', { name: 'Upload ad' }));

      expect(await screen.findByText('This client no longer exists. Go back and choose another.')).toBeInTheDocument();
    });

    it('shows a failed upload in words and finishes it with Try again, using a fresh address and the same file', async () => {
      let attempt = 0;
      restoreTransport();
      useTransport(async () => {
        attempt += 1;
        if (attempt === 1) throw new StorageNetworkError();
        return { status: 200 };
      });
      const { calls } = installSetup();
      renderPortalAt(`/stations/${stationId}/ads/new`);
      await chooseClientAndContinue(/Brand A/);
      await person.upload(screen.getByLabelText('Audio file'), audioFile());
      await screen.findByLabelText('Ad title');
      await person.click(screen.getByRole('button', { name: 'Upload ad' }));

      expect(await screen.findByText('The connection dropped during the upload. Try again.')).toBeInTheDocument();
      expect(calls.some((call) => call.path.endsWith('/complete'))).toBe(false);

      await person.click(screen.getByRole('button', { name: 'Try again' }));
      const progress = await screen.findByRole('list', { name: 'Upload progress' });
      await waitFor(() => expect(within(progress).getByText('Checked')).toBeInTheDocument());
      expect(transportCalls.map((call) => call.url)).toEqual([uploadInstructions.url, 'https://storage.test/second-address']);
      expect(screen.queryByText('The connection dropped during the upload. Try again.')).not.toBeInTheDocument();
    });
  });

  describe('coming back to a draft', () => {
    it('asks for the file again when the page was reloaded, then uploads it to the same ad', async () => {
      const { calls } = installSetup();
      renderPortalAt(`/stations/${stationId}/ads/${adId}/setup`);

      expect(await screen.findByRole('heading', { level: 1, name: 'Your audio' })).toBeInTheDocument();
      expect(screen.getByText(/For/)).toHaveTextContent('For Brand A');
      expect(screen.getByText('Draft saved')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Choose the audio file' })).toBeInTheDocument();

      await person.upload(screen.getByLabelText('Audio file'), audioFile());
      const progress = await screen.findByRole('list', { name: 'Upload progress' });
      await waitFor(() => expect(within(progress).getByText('Checked')).toBeInTheDocument());

      expect(calls.some((call) => call.method === 'POST' && call.path === `/stations/${stationId}/ads`)).toBe(false);
      expect(calls.find((call) => call.path.endsWith('/upload-url'))?.body).toEqual({ upload: { fileName: 'summer_offer.mp3', contentType: 'audio/mpeg', sizeBytes: 2_048 } });
      expect(transportCalls[0]?.url).toBe('https://storage.test/second-address');
    });

    it('explains a refused file in words and offers a different one, never the same file again', async () => {
      installSetup({ draft: newDraft({ status: 'FAILED', processingErrorCode: 'not_the_declared_audio_format' }) });
      renderPortalAt(`/stations/${stationId}/ads/${adId}/setup`);

      expect(await screen.findByText("This file isn't a valid MP3, WAV or M4A audio file. Choose a different file.")).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Choose a different file' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    });

    it('checks a replacement file before sending it', async () => {
      const { calls } = installSetup({ draft: newDraft({ status: 'FAILED', processingErrorCode: 'size_or_type_mismatch' }) });
      renderPortalAt(`/stations/${stationId}/ads/${adId}/setup`);
      await screen.findByRole('button', { name: 'Choose a different file' });

      await personWhoMayChooseAnyFile.upload(screen.getByLabelText('Replacement audio file'), audioFile('notes.txt', 'text/plain'));
      expect(await screen.findByText('Choose an MP3, WAV or M4A audio file.')).toBeInTheDocument();
      expect(calls.some((call) => call.path.endsWith('/upload-url'))).toBe(false);
    });

    it('says plainly when the ad is not found at this station', async () => {
      installSetup({ extra: { [`GET /stations/${stationId}/ads/${adId}`]: () => errorResponse(404, 'NOT_FOUND', 'We could not find that.') } });
      renderPortalAt(`/stations/${stationId}/ads/${adId}/setup`);
      expect(await screen.findByRole('heading', { name: "We couldn't find that ad" })).toBeInTheDocument();
    });

    it('resumes at the first unfinished step and keeps it in the address, so the page does not move on by itself', async () => {
      installSetup();
      const { router } = renderPortalAt(`/stations/${stationId}/ads/${adId}/setup`);
      await screen.findByRole('heading', { level: 1, name: 'Your audio' });
      await waitFor(() => expect(router.state.location.search).toBe('?step=audio'));
    });

    it('resumes at the buttons once the audio is in and there are none yet', async () => {
      installSetup({ draft: newDraft({ status: 'PROCESSING', uploadedAt: new Date().toISOString() }) });
      const { router } = renderPortalAt(`/stations/${stationId}/ads/${adId}/setup`);
      expect(await screen.findByRole('heading', { level: 1, name: 'Add the buttons' })).toBeInTheDocument();
      await waitFor(() => expect(router.state.location.search).toBe('?step=buttons'));
    });

    it('resumes at the schedule once the buttons are done and there are no times yet', async () => {
      installSetup({
        draft: newDraft({ status: 'PROCESSING', uploadedAt: new Date().toISOString(), actionCard: actionCardFixture() }),
        extra: { [`GET /stations/${stationId}`]: () => jsonResponse(200, { timeZone: 'Africa/Lusaka' }) },
      });
      const { router } = renderPortalAt(`/stations/${stationId}/ads/${adId}/setup`);
      expect(await screen.findByRole('heading', { level: 1, name: 'Set when it airs' })).toBeInTheDocument();
      expect(screen.getByText('Step 4 of 5 · Schedule')).toBeInTheDocument();
      await waitFor(() => expect(router.state.location.search).toBe('?step=schedule'));
    });

    it('stops before the review for now, with an honest note, when the times are done too', async () => {
      installSetup({
        draft: newDraft({ status: 'PROCESSING', uploadedAt: new Date().toISOString(), actionCard: actionCardFixture(), schedule: scheduleFixture(), campaign: campaignSummary({ displayStatus: 'DRAFT' }) }),
      });
      const { router } = renderPortalAt(`/stations/${stationId}/ads/${adId}/setup`);
      expect(await screen.findByRole('heading', { name: 'This step is coming next' })).toBeInTheDocument();
      expect(screen.getByText('Step 5 of 5 · Review')).toBeInTheDocument();
      await waitFor(() => expect(router.state.location.search).toBe('?step=review'));
    });
  });

  describe('leaving', () => {
    it('leaves at once when nothing has been chosen', async () => {
      installSetup();
      const { router } = renderPortalAt(`/stations/${stationId}/ads/new`);
      await screen.findByRole('heading', { name: 'Who is this ad for?' });
      await person.click(screen.getByRole('button', { name: 'Exit' }));
      expect(router.state.location.pathname).toBe(`/stations/${stationId}/ads`);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('asks first when leaving would lose a choice, and can be told to keep working', async () => {
      installSetup();
      const { router } = renderPortalAt(`/stations/${stationId}/ads/new`);
      await person.click(await screen.findByRole('radio', { name: /Brand A/ }));

      await person.click(screen.getByRole('button', { name: 'Exit' }));
      const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
      expect(dialog).toHaveTextContent('Nothing is saved until you upload the ad');

      await person.click(within(dialog).getByRole('button', { name: 'Keep working' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(router.state.location.pathname).toBe(`/stations/${stationId}/ads/new`);

      await person.click(screen.getByRole('button', { name: 'Exit' }));
      await person.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Leave' }));
      expect(router.state.location.pathname).toBe(`/stations/${stationId}/ads`);
    });

    it('saves and closes a draft: back to Drafts with a plain confirmation', async () => {
      installSetup();
      const { router } = renderPortalAt(`/stations/${stationId}/ads/new`);
      await chooseClientAndContinue(/Brand A/);
      await person.upload(screen.getByLabelText('Audio file'), audioFile());
      await screen.findByLabelText('Ad title');
      await person.click(screen.getByRole('button', { name: 'Upload ad' }));
      const progress = await screen.findByRole('list', { name: 'Upload progress' });
      await waitFor(() => expect(within(progress).getByText('Checked')).toBeInTheDocument());

      await person.click(screen.getByRole('button', { name: 'Save and close' }));

      expect(router.state.location.pathname).toBe(`/stations/${stationId}/ads`);
      expect(router.state.location.search).toBe('?view=drafts');
      expect(await screen.findByText('Draft saved. Continue setup from Drafts any time.')).toBeInTheDocument();
    });

    it('says the upload carries on when leaving while it is still going up', async () => {
      restoreTransport();
      useTransport(() => new Promise(() => undefined));
      installSetup();
      renderPortalAt(`/stations/${stationId}/ads/new`);
      await chooseClientAndContinue(/Brand A/);
      await person.upload(screen.getByLabelText('Audio file'), audioFile());
      await screen.findByLabelText('Ad title');
      await person.click(screen.getByRole('button', { name: 'Upload ad' }));
      await screen.findByRole('button', { name: 'Stop upload' });

      await person.click(screen.getByRole('button', { name: 'Save and close' }));
      expect(await screen.findByText('Draft saved. The upload carries on — keep this tab open until it finishes.')).toBeInTheDocument();
    });

    it('lets the person stop an upload that is going up', async () => {
      restoreTransport();
      useTransport(({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new StorageUploadCancelled()))));
      installSetup();
      renderPortalAt(`/stations/${stationId}/ads/new`);
      await chooseClientAndContinue(/Brand A/);
      await person.upload(screen.getByLabelText('Audio file'), audioFile());
      await screen.findByLabelText('Ad title');
      await person.click(screen.getByRole('button', { name: 'Upload ad' }));

      await person.click(await screen.findByRole('button', { name: 'Stop upload' }));
      expect(await screen.findByText('You stopped the upload.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });
  });

  describe('who may set up ads', () => {
    it('tells an analyst, in plain words, that they can look but not change', async () => {
      const analyst = signedInUserWith([{ role: 'ANALYST' }]);
      installSetup({ user: analyst });
      renderPortalAt(`/stations/${analyst.stations[0]?.id}/ads/new`);

      expect(await screen.findByRole('heading', { name: "You can't set up ads" })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Go to the ads' })).toHaveAttribute('href', `/stations/${analyst.stations[0]?.id}/ads`);
      expect(screen.queryByRole('heading', { name: 'Who is this ad for?' })).not.toBeInTheDocument();
    });

    it('keeps an analyst out of an existing draft too', async () => {
      const analyst = signedInUserWith([{ role: 'ANALYST' }]);
      installSetup({ user: analyst });
      renderPortalAt(`/stations/${analyst.stations[0]?.id}/ads/${adId}/setup`);
      expect(await screen.findByRole('heading', { name: "You can't set up ads" })).toBeInTheDocument();
    });

    it('tells a station that is still under review that ads are not available yet', async () => {
      const waiting = signedInUserWith([{ role: 'OWNER', status: 'PENDING_REVIEW' }]);
      installSetup({ user: waiting });
      renderPortalAt(`/stations/${waiting.stations[0]?.id}/ads/new`);
      expect(await screen.findByRole('heading', { name: 'Not available yet' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: "See your station's details" })).toHaveAttribute('href', `/stations/${waiting.stations[0]?.id}/profile`);
    });

    it('treats a station the person is not part of as not found', async () => {
      installSetup();
      renderPortalAt('/stations/0190f1a2-0000-7000-8000-0000000fffff/ads/new');
      expect(await screen.findByRole('heading', { name: "We couldn't find that page" })).toBeInTheDocument();
    });
  });
});
