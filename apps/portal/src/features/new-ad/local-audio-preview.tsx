import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/icons';
import { WaveformBars } from '../../components/waveform-bars';

/** Plays the chosen file from the person's own device (it has not been uploaded yet), drawn with its real waveform when known. */
export function LocalAudioPreview({ file, peaks, title }: { file: Blob; peaks: number[] | null; title: string }) {
  const audioReference = useRef<HTMLAudioElement | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    setIsPlaying(false);
    setProgress(0);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const toggle = () => {
    const audio = audioReference.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      void audio.play().then(() => setIsPlaying(true), () => setIsPlaying(false));
    }
  };

  return (
    <div className="flex items-center gap-4">
      <button type="button" onClick={toggle} aria-label={`${isPlaying ? 'Pause' : 'Play'} ${title || 'the chosen file'}`} className="flex size-12 shrink-0 items-center justify-center rounded-pill bg-ink text-surface hover:bg-muted">
        <Icon name={isPlaying ? 'pause' : 'play'} size={20} />
      </button>
      <WaveformBars seed={title || 'chosen file'} heights={peaks} progress={progress} />
      {objectUrl ? (
        <audio
          ref={audioReference}
          src={objectUrl}
          onTimeUpdate={(event) => setProgress(event.currentTarget.duration > 0 ? event.currentTarget.currentTime / event.currentTarget.duration : 0)}
          onEnded={() => {
            setIsPlaying(false);
            setProgress(0);
          }}
          className="hidden"
        />
      ) : null}
    </div>
  );
}
