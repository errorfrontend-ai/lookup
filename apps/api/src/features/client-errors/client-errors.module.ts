import { Module } from '@nestjs/common';
import { ClientErrorsController } from './client-errors.controller.js';

@Module({ controllers: [ClientErrorsController] })
export class ClientErrorsModule {}
