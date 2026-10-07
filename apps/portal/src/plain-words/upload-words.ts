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

/** Why an upload did not finish, and what to do, in words. `refused` is explained by the reason the API recorded instead. */
export function describeUploadFailure(failure: 'network' | 'link_expired' | 'storage_refused' | 'link_failed' | 'not_received' | 'refused' | 'check_failed' | 'cancelled'): string {
  switch (failure) {
    case 'network':
      return 'The connection dropped during the upload. Try again.';
    case 'link_expired':
      return "The upload link expired before the file finished. Try again — we'll make a new link.";
    case 'storage_refused':
      return "The upload didn't finish. Try again.";
    case 'link_failed':
      return "We couldn't start the upload. Try again.";
    case 'not_received':
      return "The file didn't reach us. Try the upload again.";
    case 'refused':
      return "This file couldn't be used.";
    case 'check_failed':
      return "We couldn't check the file just now. Try again.";
    case 'cancelled':
      return 'You stopped the upload.';
  }
}
