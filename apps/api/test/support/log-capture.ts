import { Writable } from 'node:stream';

export type LogLine = Record<string, unknown>;

/** Collects the API's structured log lines so tests can check what reached the private log. */
export class LogCapture extends Writable {
  readonly lines: LogLine[] = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    for (const text of chunk.toString('utf8').split('\n').filter(Boolean)) {
      try {
        this.lines.push(JSON.parse(text) as LogLine);
      } catch {
        this.lines.push({ unparsed: text });
      }
    }
    done();
  }

  find(matches: (line: LogLine) => boolean): LogLine | undefined {
    return this.lines.find(matches);
  }
}

/** Let pino finish pending writes before a test reads the captured log. */
export const waitForLogWrites = () => new Promise((resolve) => setTimeout(resolve, 50));
