/** Why an upload was refused, in words (the codes are UPLOAD_REFUSAL_REASONS in the contracts). */
export function describeUploadRefusal(reason: string | null): string {
  switch (reason) {
    case 'size_or_type_mismatch':
      return "The file that arrived wasn't the one you chose. Please upload it again.";
    case 'not_the_declared_audio_format':
      return "This file isn't a valid MP3, WAV or M4A audio file. Choose a different file.";
    default:
      return "This file couldn't be used. Choose a different file.";
  }
}
