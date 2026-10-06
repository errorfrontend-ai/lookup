import { useCallback, useRef, useState } from 'react';
import { type AudioFileCheck, checkAudioFile, titleFromFileName } from './check-audio-file';

export interface ChosenAudio {
  file: File | null;
  /** The ad's title: starts as the file's name tidied up, until the person types their own. */
  title: string;
  setTitle: (title: string) => void;
  /** The result of looking at the file, or null before one is chosen or while it is being looked at. */
  check: AudioFileCheck | null;
  isChecking: boolean;
  choose: (file: File) => Promise<void>;
  clear: () => void;
}

/** The file and title being prepared for a new ad, before anything is sent to the server. */
export function useChosenAudio(): ChosenAudio {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitleText] = useState('');
  const [check, setCheck] = useState<AudioFileCheck | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const hasTypedTitle = useRef(false);
  const latestChoice = useRef(0);

  const choose = useCallback(async (nextFile: File) => {
    const thisChoice = ++latestChoice.current;
    setFile(nextFile);
    setCheck(null);
    setIsChecking(true);
    if (!hasTypedTitle.current) setTitleText(titleFromFileName(nextFile.name));
    const result = await checkAudioFile(nextFile);
    // A newer choice made while this one was being looked at wins.
    if (thisChoice !== latestChoice.current) return;
    setCheck(result);
    setIsChecking(false);
  }, []);

  const clear = useCallback(() => {
    latestChoice.current += 1;
    setFile(null);
    setCheck(null);
    setIsChecking(false);
  }, []);

  const setTitle = useCallback((nextTitle: string) => {
    hasTypedTitle.current = true;
    setTitleText(nextTitle);
  }, []);

  return { file, title, setTitle, check, isChecking, choose, clear };
}
