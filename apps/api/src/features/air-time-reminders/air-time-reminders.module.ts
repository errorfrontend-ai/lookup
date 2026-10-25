import { Module } from '@nestjs/common';
import { AirTimeReminders } from './air-time-reminders.js';

/** Reminders before each slot of a client's adverts (ADR-006 decision 6; P5C-NOTIFY-04). */
@Module({ providers: [AirTimeReminders], exports: [AirTimeReminders] })
export class AirTimeRemindersModule {}
