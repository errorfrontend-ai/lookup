import { Module } from '@nestjs/common';
import { RecognitionController } from './recognition.controller.js';
import { RecognitionRecords } from './recognition-records.js';
import { RecognitionService } from './recognition.service.js';
import { StationChoiceController } from './station-choice.controller.js';

@Module({ controllers: [RecognitionController, StationChoiceController], providers: [RecognitionService, RecognitionRecords] })
export class RecognitionModule {}
