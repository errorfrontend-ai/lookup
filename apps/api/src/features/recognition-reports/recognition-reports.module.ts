import { Module } from '@nestjs/common';
import { RecognitionReportsController } from './recognition-reports.controller.js';
import { RecognitionReports } from './recognition-reports.js';

/** "Report this" from the listener app (P4 design §5.9, approved 11 October 2026). */
@Module({ controllers: [RecognitionReportsController], providers: [RecognitionReports] })
export class RecognitionReportsModule {}
