import { Global, Module } from '@nestjs/common';
import { IngestQueue } from './ingest-queue.js';
import { RecognizeQueue } from './recognize-queue.js';

/** The BullMQ queues the Python fingerprint workers take jobs from (docs/design/step-3-engine-hookup.md). */
@Global()
@Module({
  providers: [RecognizeQueue, IngestQueue],
  exports: [RecognizeQueue, IngestQueue],
})
export class JobQueuesModule {}
