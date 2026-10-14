import { Module } from '@nestjs/common';
import { AuthenticationModule } from '../authentication/authentication.module.js';
import { PhoneVerificationCodes } from './phone-verification-codes.js';
import { RegistrationController, StationApplicationController, StationChangeRequestController } from './registration.controller.js';
import { RegistrationService } from './registration.service.js';
import { StationChangeRequests } from './station-change-requests.js';
import { StationLogoProcessor } from './station-logo-processing.js';
import { StationUploads } from './station-uploads.js';

/** Station self sign-up (P5A design §3.3; P5A-STRUCTURE-01). */
@Module({
  imports: [AuthenticationModule],
  controllers: [RegistrationController, StationApplicationController, StationChangeRequestController],
  providers: [RegistrationService, PhoneVerificationCodes, StationUploads, StationLogoProcessor, StationChangeRequests],
})
export class RegistrationModule {}
