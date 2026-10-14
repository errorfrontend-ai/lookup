import {
  ChangeApplicantAccountInput,
  CheckPhoneVerificationCodeInput,
  ConfirmEmailVerificationInput,
  type RegisteredStationApplicant,
  RegisterStationApplicantInput,
  RequestStationDetailChangeInput,
  SaveStationApplicationDetailsInput,
  SaveStationLicenceInput,
  type SignedInPortalUser,
  StartLicenceDocumentUploadInput,
  StartStationLogoUploadInput,
  type StationApplication,
  type StationChangeRequestState,
  type StationUploadAddress,
  SubmitStationApplicationInput,
} from '@lookup/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RateLimit } from '../../common/rate-limiting/rate-limit.decorator.js';
import { UuidOrNotFoundPipe } from '../../common/validation/uuid-or-not-found.pipe.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import type { RequestFacts } from '../authentication/authentication.service.js';
import { PublicRoute } from '../authentication/public-route.decorator.js';
import { StationAccess, type StationAccessRequirement } from '../stations/station-access.decorator.js';
import { StationAccessGuard } from '../stations/station-access.guard.js';
import {
  APPLICANTS_PER_ADDRESS,
  EMAIL_CONFIRMATIONS_PER_ADDRESS,
  EMAIL_LINKS_SENT_PER_ADDRESS,
  PHONE_CODE_CHECKS_PER_ADDRESS,
  PHONE_CODES_SENT_PER_ADDRESS,
} from './registration-rate-limits.js';
import { RegistrationService } from './registration.service.js';
import { StationChangeRequests } from './station-change-requests.js';
import { StationUploads } from './station-uploads.js';

/** Any member reads the application, in every status (P5A design §3.3). */
const READ_APPLICATION: StationAccessRequirement = { allowedRoles: ['OWNER', 'MANAGER', 'ANALYST'], requiresActiveStation: false };
/** Only an owner changes it; the database functions check the status. */
const CHANGE_APPLICATION: StationAccessRequirement = { allowedRoles: ['OWNER'], requiresActiveStation: false };

/** The routes anyone may call: step 1 and the email link. Both need an allowed Origin (they can set cookies). */
@Controller('registration')
export class RegistrationController {
  constructor(private readonly registrationService: RegistrationService) {}

  @Post('applicants')
  @PublicRoute()
  @RateLimit(APPLICANTS_PER_ADDRESS)
  @HttpCode(201)
  registerApplicant(
    @Body(new ZodValidationPipe(RegisterStationApplicantInput)) input: RegisterStationApplicantInput & { mobileNumber: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SignedInPortalUser & RegisteredStationApplicant> {
    return this.registrationService.registerApplicant(input, requestFacts(request), response);
  }

  @Post('email-verifications')
  @PublicRoute()
  @RateLimit(EMAIL_CONFIRMATIONS_PER_ADDRESS)
  @HttpCode(204)
  async confirmEmail(@Body(new ZodValidationPipe(ConfirmEmailVerificationInput)) input: ConfirmEmailVerificationInput, @Req() request: Request): Promise<void> {
    await this.registrationService.confirmEmail(input.token, requestFacts(request));
  }
}

/** An applicant's own station: steps 1 (changed) to 4, the codes, the files and the submission. */
@Controller('stations/:stationId/application')
@UseGuards(StationAccessGuard)
export class StationApplicationController {
  constructor(
    private readonly registrationService: RegistrationService,
    private readonly stationUploads: StationUploads,
  ) {}

  @Get()
  @StationAccess(READ_APPLICATION)
  read(): Promise<StationApplication> {
    return this.registrationService.readApplication();
  }

  @Put('account')
  @StationAccess(CHANGE_APPLICATION)
  changeAccount(
    @Body(new ZodValidationPipe(ChangeApplicantAccountInput)) input: ChangeApplicantAccountInput & { mobileNumber: string },
    @Req() request: Request,
  ): Promise<StationApplication> {
    return this.registrationService.changeAccount(input, requestFacts(request));
  }

  @Post('phone-verification-codes')
  @StationAccess(CHANGE_APPLICATION)
  @RateLimit(PHONE_CODES_SENT_PER_ADDRESS)
  @HttpCode(200)
  async sendPhoneCode(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<{ sentAt: string | null; resendAvailableAt: string | null }> {
    const sent = await this.registrationService.sendPhoneCode(requestFacts(request), response);
    return sent ?? { sentAt: null, resendAvailableAt: null };
  }

  @Post('phone-verification')
  @StationAccess(CHANGE_APPLICATION)
  @RateLimit(PHONE_CODE_CHECKS_PER_ADDRESS)
  @HttpCode(204)
  async checkPhoneCode(
    @Body(new ZodValidationPipe(CheckPhoneVerificationCodeInput)) input: CheckPhoneVerificationCodeInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.registrationService.checkPhoneCode(input.code, requestFacts(request), response);
  }

  @Post('email-verification-links')
  @StationAccess(CHANGE_APPLICATION)
  @RateLimit(EMAIL_LINKS_SENT_PER_ADDRESS)
  @HttpCode(204)
  async sendEmailLink(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    await this.registrationService.sendEmailLink(requestFacts(request), response);
  }

  @Put('details')
  @StationAccess(CHANGE_APPLICATION)
  saveDetails(
    @Body(new ZodValidationPipe(SaveStationApplicationDetailsInput)) input: SaveStationApplicationDetailsInput,
    @Req() request: Request,
  ): Promise<StationApplication> {
    return this.registrationService.saveDetails(input, requestFacts(request));
  }

  @Post('logo-uploads')
  @StationAccess(CHANGE_APPLICATION)
  startLogoUpload(
    @Body(new ZodValidationPipe(StartStationLogoUploadInput)) input: StartStationLogoUploadInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StationUploadAddress> {
    return this.stationUploads.start('logo', input, response);
  }

  @Post('logo-uploads/:uploadId/complete')
  @StationAccess(CHANGE_APPLICATION)
  async completeLogoUpload(@Param('uploadId', new UuidOrNotFoundPipe()) uploadId: string, @Req() request: Request): Promise<StationApplication> {
    await this.stationUploads.complete('logo', uploadId, requestFacts(request));
    return this.registrationService.readApplication();
  }

  @Put('licence')
  @StationAccess(CHANGE_APPLICATION)
  saveLicence(@Body(new ZodValidationPipe(SaveStationLicenceInput)) input: SaveStationLicenceInput, @Req() request: Request): Promise<StationApplication> {
    return this.registrationService.saveLicenceNumber(input.licenceNumber, requestFacts(request));
  }

  @Post('licence-document-uploads')
  @StationAccess(CHANGE_APPLICATION)
  startLicenceDocumentUpload(
    @Body(new ZodValidationPipe(StartLicenceDocumentUploadInput)) input: StartLicenceDocumentUploadInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StationUploadAddress> {
    return this.stationUploads.start('licence-document', input, response);
  }

  @Post('licence-document-uploads/:uploadId/complete')
  @StationAccess(CHANGE_APPLICATION)
  async completeLicenceDocumentUpload(@Param('uploadId', new UuidOrNotFoundPipe()) uploadId: string, @Req() request: Request): Promise<StationApplication> {
    await this.stationUploads.complete('licence-document', uploadId, requestFacts(request));
    return this.registrationService.readApplication();
  }

  @Post('submission')
  @StationAccess(CHANGE_APPLICATION)
  @HttpCode(200)
  submit(@Body(new ZodValidationPipe(SubmitStationApplicationInput)) _input: SubmitStationApplicationInput, @Req() request: Request): Promise<StationApplication> {
    return this.registrationService.submit(requestFacts(request));
  }
}

/** Any member reads the approved details and the change waiting; an owner of an approved station asks for one. */
const READ_CHANGE_REQUEST: StationAccessRequirement = { allowedRoles: ['OWNER', 'MANAGER', 'ANALYST'], requiresActiveStation: false };
const ASK_FOR_A_CHANGE: StationAccessRequirement = { allowedRoles: ['OWNER'], requiresActiveStation: true };
const WITHDRAW_A_CHANGE: StationAccessRequirement = { allowedRoles: ['OWNER'], requiresActiveStation: false };

/** O2 (P5A-D4; journey E): an approved station's change of name, frequency or licence, waiting for review. */
@Controller('stations/:stationId')
@UseGuards(StationAccessGuard)
export class StationChangeRequestController {
  constructor(
    private readonly changeRequests: StationChangeRequests,
    private readonly stationUploads: StationUploads,
  ) {}

  @Get('change-request')
  @StationAccess(READ_CHANGE_REQUEST)
  read(): Promise<StationChangeRequestState> {
    return this.changeRequests.read();
  }

  @Post('change-requests')
  @StationAccess(ASK_FOR_A_CHANGE)
  @HttpCode(201)
  request(@Body(new ZodValidationPipe(RequestStationDetailChangeInput)) input: RequestStationDetailChangeInput, @Req() request: Request): Promise<StationChangeRequestState> {
    return this.changeRequests.request(input, requestFacts(request));
  }

  @Post('change-request/withdrawal')
  @StationAccess(WITHDRAW_A_CHANGE)
  @HttpCode(200)
  withdraw(@Req() request: Request): Promise<StationChangeRequestState> {
    return this.changeRequests.withdraw(requestFacts(request));
  }

  @Post('change-request/licence-document-uploads')
  @StationAccess(ASK_FOR_A_CHANGE)
  startDocumentUpload(
    @Body(new ZodValidationPipe(StartLicenceDocumentUploadInput)) input: StartLicenceDocumentUploadInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StationUploadAddress> {
    return this.stationUploads.start('change-request-document', input, response);
  }

  @Post('change-request/licence-document-uploads/:uploadId/complete')
  @StationAccess(ASK_FOR_A_CHANGE)
  @HttpCode(204)
  async completeDocumentUpload(@Param('uploadId', new UuidOrNotFoundPipe()) uploadId: string, @Req() request: Request): Promise<void> {
    await this.stationUploads.complete('change-request-document', uploadId, requestFacts(request));
  }
}

function requestFacts(request: Request): RequestFacts {
  return { requestId: (request as Request & { id?: string }).id ?? 'unknown', clientAddress: request.ip ?? 'unknown' };
}
