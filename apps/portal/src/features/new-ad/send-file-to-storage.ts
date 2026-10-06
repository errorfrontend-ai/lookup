/** The storage did not answer: the connection dropped or could not be made. */
export class StorageNetworkError extends Error {
  constructor() {
    super('The connection to storage failed');
    this.name = 'StorageNetworkError';
  }
}

/** The person stopped the upload. */
export class StorageUploadCancelled extends Error {
  constructor() {
    super('The upload was cancelled');
    this.name = 'StorageUploadCancelled';
  }
}

export interface StorageTransportRequest {
  url: string;
  file: Blob;
  /** Exactly the type the upload address was signed for; storage refuses anything else. */
  contentType: string;
  /** Called with a fraction from 0 to 1 as the file goes up. */
  onProgress: (fraction: number) => void;
  signal: AbortSignal;
}

export type StorageTransport = (request: StorageTransportRequest) => Promise<{ status: number }>;

/**
 * Sends the file straight from the browser to storage with the address the API signed. XMLHttpRequest
 * rather than fetch, because it reports progress. No cookies go to storage, and the only header is the
 * signed Content-Type (the size is signed too, and the browser sets it from the file).
 */
export const sendFileToStorage: StorageTransport = ({ url, file, contentType, onProgress, signal }) =>
  new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.setRequestHeader('Content-Type', contentType);
    request.withCredentials = false;
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    request.onload = () => resolve({ status: request.status });
    request.onerror = () => reject(new StorageNetworkError());
    request.ontimeout = () => reject(new StorageNetworkError());
    request.onabort = () => reject(new StorageUploadCancelled());
    if (signal.aborted) {
      reject(new StorageUploadCancelled());
      return;
    }
    signal.addEventListener('abort', () => request.abort(), { once: true });
    request.send(file);
  });
