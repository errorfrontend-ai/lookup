import { Module } from '@nestjs/common';
import { EngagementsController } from './engagements.controller.js';
import { Engagements } from './engagements.js';

/** Button taps from the listener app, and the campaigns' tap limits (P4 design §5.8; P4-DELIVERY-02). */
@Module({ controllers: [EngagementsController], providers: [Engagements] })
export class EngagementsModule {}
