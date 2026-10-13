import { Module } from '@nestjs/common';
import { RecognitionController } from './recognition.controller.js';
import { RecognitionIdempotencyKeyCleanUp } from './recognition-idempotency-key-clean-up.js';
import { RecognitionRecords } from './recognition-records.js';
import { RecognitionService } from './recognition.service.js';
import { StationChoiceController } from './station-choice.controller.js';

@Module({ controllers: [RecognitionController, StationChoiceController], providers: [RecognitionService, RecognitionRecords, RecognitionIdempotencyKeyCleanUp] })
export class RecognitionModule {}
