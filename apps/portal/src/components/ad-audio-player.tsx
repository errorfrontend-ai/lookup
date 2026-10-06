import type { AdPlaybackUrl } from '@lookup/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { portalApi } from '../app/portal-api';
import { stationQueryKeys } from '../features/stations/station-query-keys';
import { Icon } from './icons';
import { WaveformBars } from './waveform-bars';

type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'failed';

const FOUR_MINUTES_MILLISECONDS = 4 * 60 * 1000;

/** Whichever player is playing right now, so starting another one stops it. */
let stopThePlayerThatIsPlaying: (() => void) | null = null;

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * Plays an ad's audio. The audio's address is asked for only when Play is pressed (nothing downloads
 * just by looking at a list, which matters on a metered connection), and an address that expired
 * while paused is replaced once, silently. Only one ad plays at a time.
 *  - "button": a round Play/Pause button, for rows in a list.
 *  - "full": the button with a waveform and the time, for an ad's own page.
 */
export function AdAudioPlayer({ stationId, adId, adTitle, variant = 'button' }: { stationId: string; adId: string; adTitle: string; variant?: 'button' | 'full' }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<PlayerState>('idle');
  const [progress, setProgress] = useState(0);
  const [clock, setClock] = useState({ position: 0, length: 0 });
  const audioReference = useRef<HTMLAudioElement | null>(null);
  const hasRetriedReference = useRef(false);

  const pausePlayer = useCallback(() => {
    audioReference.current?.pause();
    setState((current) => (current === 'playing' ? 'paused' : current));
  }, []);

  const fetchPlaybackUrl = useCallback(
    (forceNew: boolean) =>
      queryClient.fetchQuery({
        queryKey: stationQueryKeys.playbackUrl(stationId, adId),
        queryFn: () => portalApi.get<AdPlaybackUrl>(`/stations/${stationId}/ads/${adId}/playback-url`),
        staleTime: forceNew ? 0 : FOUR_MINUTES_MILLISECONDS,
      }),
    [queryClient, stationId, adId],
  );

  const startPlaying = useCallback(
    async (forceNewUrl: boolean) => {
      setState('loading');
      try {
        const playback = await fetchPlaybackUrl(forceNewUrl);
        const audio = audioReference.current ?? new Audio();
        audioReference.current = audio;
        audio.src = playback.url;
        stopThePlayerThatIsPlaying?.();
        stopThePlayerThatIsPlaying = pausePlayer;
        await audio.play();
        setState('playing');
      } catch {
        setState('failed');
      }
    },
    [fetchPlaybackUrl, pausePlayer],
  );

  useEffect(() => {
    const audio = audioReference.current;
    if (!audio) return undefined;
    const onTimeUpdate = () => {
      setProgress(audio.duration > 0 ? audio.currentTime / audio.duration : 0);
      setClock({ position: audio.currentTime, length: audio.duration });
    };
    const onEnded = () => {
      setState('idle');
      setProgress(0);
    };
    const onError = () => {
      // The address may have expired while paused: ask for a new one once, then give up.
      if (hasRetriedReference.current) {
        setState('failed');
        return;
      }
      hasRetriedReference.current = true;
      void startPlaying(true);
    };
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, [state, startPlaying]);

  useEffect(
    () => () => {
      audioReference.current?.pause();
      if (stopThePlayerThatIsPlaying === pausePlayer) stopThePlayerThatIsPlaying = null;
    },
    [pausePlayer],
  );

  const press = () => {
    if (state === 'loading') return;
    if (state === 'playing') {
      pausePlayer();
      return;
    }
    hasRetriedReference.current = false;
    if (state === 'paused' && audioReference.current) {
      stopThePlayerThatIsPlaying?.();
      stopThePlayerThatIsPlaying = pausePlayer;
      void audioReference.current.play().then(
        () => setState('playing'),
        () => void startPlaying(true),
      );
      return;
    }
    void startPlaying(false);
  };

  const label = state === 'playing' ? `Pause ${adTitle}` : state === 'loading' ? `Loading ${adTitle}` : `Play ${adTitle}`;
  const sizeClasses = variant === 'full' ? 'size-12 bg-ink text-surface hover:bg-muted' : 'size-11 border border-line bg-surface text-ink hover:bg-ground';

  const button = (
    <button
      type="button"
      onClick={press}
      aria-label={label}
      aria-busy={state === 'loading' || undefined}
      title={state === 'failed' ? "We couldn't play this audio. Try again." : undefined}
      className={`flex shrink-0 items-center justify-center rounded-pill ${sizeClasses} ${state === 'failed' ? 'border-2 border-danger' : ''}`}
    >
      {state === 'loading' ? (
        <span aria-hidden="true" className="size-4 animate-spin rounded-pill border-2 border-current border-t-transparent motion-reduce:animate-none" />
      ) : (
        <Icon name={state === 'playing' ? 'pause' : 'play'} size={variant === 'full' ? 20 : 16} />
      )}
    </button>
  );

  if (variant === 'button') {
    return (
      <>
        {button}
        {state === 'failed' ? (
          <span role="alert" className="sr-only">
            We couldn't play this audio. Try again.
          </span>
        ) : null}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4">
        {button}
        <WaveformBars seed={adId} progress={progress} />
        <span className="w-20 shrink-0 text-right text-label tabular-nums text-muted">
          {clock.length > 0 ? `${formatClock(clock.position)} / ${formatClock(clock.length)}` : '—'}
        </span>
      </div>
      {state === 'failed' ? (
        <span role="alert" className="text-caption font-bold text-danger">
          We couldn't play this audio. Try again.
        </span>
      ) : null}
    </div>
  );
}
