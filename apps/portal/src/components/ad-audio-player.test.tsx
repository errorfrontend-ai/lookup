import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../app/portal-api';
import { installFakeApi, jsonResponse } from '../test/fake-api';
import { AdAudioPlayer } from './ad-audio-player';
import { waveformHeights } from './waveform-bars';

const person = userEvent.setup({ delay: null });

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPlayers(players: Array<{ adId: string; title: string; variant?: 'button' | 'full' }>) {
  return render(
    <QueryClientProvider client={queryClient}>
      {players.map((player) => (
        <AdAudioPlayer key={player.adId} stationId="s1" adId={player.adId} adTitle={player.title} variant={player.variant} />
      ))}
    </QueryClientProvider>,
  );
}

function installPlayback(urlFor: (adId: string) => string = (adId) => `http://127.0.0.1:39000/${adId}.wav`) {
  return installFakeApi({
    'GET /stations/s1/ads/ad-one/playback-url': () => jsonResponse(200, { url: urlFor('ad-one'), expiresAt: '2026-10-06T12:10:00Z' }),
    'GET /stations/s1/ads/ad-two/playback-url': () => jsonResponse(200, { url: urlFor('ad-two'), expiresAt: '2026-10-06T12:10:00Z' }),
  });
}

describe('AdAudioPlayer', () => {
  it('downloads nothing until Play is pressed, then plays, and Pause stops it', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const fakeApi = installPlayback();
    renderPlayers([{ adId: 'ad-one', title: 'Summer offer' }]);
    expect(fakeApi.calls).toHaveLength(0);

    await person.click(screen.getByRole('button', { name: 'Play Summer offer' }));
    expect(await screen.findByRole('button', { name: 'Pause Summer offer' })).toBeInTheDocument();
    expect(play).toHaveBeenCalledTimes(1);
    expect(fakeApi.calls).toHaveLength(1);

    await person.click(screen.getByRole('button', { name: 'Pause Summer offer' }));
    expect(await screen.findByRole('button', { name: 'Play Summer offer' })).toBeInTheDocument();
    expect(pause).toHaveBeenCalled();
  });

  it('resumes a paused ad without asking for the audio again', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const fakeApi = installPlayback();
    renderPlayers([{ adId: 'ad-one', title: 'Summer offer' }]);

    await person.click(screen.getByRole('button', { name: 'Play Summer offer' }));
    await person.click(await screen.findByRole('button', { name: 'Pause Summer offer' }));
    await person.click(await screen.findByRole('button', { name: 'Play Summer offer' }));
    expect(await screen.findByRole('button', { name: 'Pause Summer offer' })).toBeInTheDocument();
    expect(fakeApi.calls).toHaveLength(1);
  });

  it('plays one ad at a time: starting a second stops the first', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    installPlayback();
    renderPlayers([
      { adId: 'ad-one', title: 'First ad' },
      { adId: 'ad-two', title: 'Second ad' },
    ]);

    await person.click(screen.getByRole('button', { name: 'Play First ad' }));
    expect(await screen.findByRole('button', { name: 'Pause First ad' })).toBeInTheDocument();
    await person.click(screen.getByRole('button', { name: 'Play Second ad' }));
    expect(await screen.findByRole('button', { name: 'Pause Second ad' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play First ad' })).toBeInTheDocument());
  });

  it('says so, in words, when the audio cannot be played, and lets the person try again', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    let isAvailable = false;
    installFakeApi({
      'GET /stations/s1/ads/ad-one/playback-url': () =>
        isAvailable ? jsonResponse(200, { url: 'http://127.0.0.1:39000/ok.wav', expiresAt: '2026-10-06T12:10:00Z' }) : jsonResponse(409, { error: { code: 'CONFLICT', message: 'x', request_id: 'x' } }),
    });
    renderPlayers([{ adId: 'ad-one', title: 'Summer offer', variant: 'full' }]);

    await person.click(screen.getByRole('button', { name: 'Play Summer offer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't play this audio. Try again.");
    isAvailable = true;
    await person.click(screen.getByRole('button', { name: 'Play Summer offer' }));
    expect(await screen.findByRole('button', { name: 'Pause Summer offer' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  describe('with the audio element in hand', () => {
    /** Replaces `new Audio()` so a test can reach the element the player makes and send it events. */
    function captureAudioElements() {
      const created: HTMLAudioElement[] = [];
      vi.stubGlobal('Audio', function CapturedAudio() {
        const element = document.createElement('audio');
        created.push(element);
        return element;
      });
      return created;
    }

    it('asks once for a new address if the old one has expired, then gives up with a message', async () => {
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      const audioElements = captureAudioElements();
      let addressNumber = 0;
      const fakeApi = installFakeApi({
        'GET /stations/s1/ads/ad-one/playback-url': () =>
          jsonResponse(200, { url: `http://127.0.0.1:39000/ad-one.wav?attempt=${++addressNumber}`, expiresAt: '2026-10-06T12:10:00Z' }),
      });
      renderPlayers([{ adId: 'ad-one', title: 'Summer offer', variant: 'full' }]);

      await person.click(screen.getByRole('button', { name: 'Play Summer offer' }));
      await screen.findByRole('button', { name: 'Pause Summer offer' });
      const audio = audioElements[0] as HTMLAudioElement;
      expect(audio.src).toContain('attempt=1');

      // The first address stopped working: one quiet retry with a fresh address.
      act(() => void audio.dispatchEvent(new Event('error')));
      await waitFor(() => expect(audio.src).toContain('attempt=2'));
      expect(fakeApi.calls).toHaveLength(2);
      await screen.findByRole('button', { name: 'Pause Summer offer' });

      // If that one fails too, say so.
      act(() => void audio.dispatchEvent(new Event('error')));
      expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't play this audio. Try again.");
      expect(fakeApi.calls).toHaveLength(2);
    });

    it('follows the playing audio: the time and the played part of the waveform advance, and the end resets it', async () => {
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      const audioElements = captureAudioElements();
      installPlayback();
      const { container } = renderPlayers([{ adId: 'ad-one', title: 'Summer offer', variant: 'full' }]);

      await person.click(screen.getByRole('button', { name: 'Play Summer offer' }));
      await screen.findByRole('button', { name: 'Pause Summer offer' });
      const audio = audioElements[0] as HTMLAudioElement;
      Object.defineProperty(audio, 'duration', { value: 6, configurable: true });
      Object.defineProperty(audio, 'currentTime', { value: 3, configurable: true });
      act(() => void audio.dispatchEvent(new Event('timeupdate')));

      expect(await screen.findByText('0:03 / 0:06')).toBeInTheDocument();
      expect(container.querySelectorAll('.bg-accent')).toHaveLength(24); // half of the 48 bars

      act(() => void audio.dispatchEvent(new Event('ended')));
      expect(await screen.findByRole('button', { name: 'Play Summer offer' })).toBeInTheDocument();
      expect(container.querySelectorAll('.bg-accent')).toHaveLength(0);
    });
  });

  it('the full player shows the waveform, with no time until the audio is known', () => {
    installPlayback();
    const { container } = renderPlayers([{ adId: 'ad-one', title: 'Summer offer', variant: 'full' }]);
    expect(container.querySelectorAll('[aria-hidden="true"] > div')).toHaveLength(48);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('waveformHeights', () => {
  it('is the same for the same ad every time, and different for another ad', () => {
    expect(waveformHeights('ad-one', 48)).toEqual(waveformHeights('ad-one', 48));
    expect(waveformHeights('ad-one', 48)).not.toEqual(waveformHeights('ad-two', 48));
  });

  it('keeps every bar visible and within the box', () => {
    const heights = waveformHeights('anything', 200);
    expect(heights).toHaveLength(200);
    for (const height of heights) {
      expect(height).toBeGreaterThanOrEqual(0.2);
      expect(height).toBeLessThanOrEqual(1);
    }
  });
});
