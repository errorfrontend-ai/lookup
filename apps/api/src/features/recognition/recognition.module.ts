import { Module } from '@nestjs/common';
import { RecognitionController } from './recognition.controller.js';
import { RecognitionRecords } from './recognition-records.js';
import { RecognitionService } from './recognition.service.js';

@Module({ controllers: [RecognitionController], providers: [RecognitionService, RecognitionRecords] })
export class RecognitionModule {}
