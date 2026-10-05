import { Global, Module } from '@nestjs/common';
import { AuditTrail } from './audit-trail.js';

@Global()
@Module({ providers: [AuditTrail], exports: [AuditTrail] })
export class AuditModule {}
