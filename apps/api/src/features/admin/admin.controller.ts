import {
  type AdminStationList,
  AdminStationSearchInput,
  type AdminSummary,
  type ApplicationDetail,
  type ApplicationQueue,
  type AudioOverlapList,
  type AudioOverlapPreviewLinks,
  type PrivateFileLink,
  type ReferenceCodeSearchResult,
  RejectApplicationInput,
  ReviewAudioOverlapInput,
  SuspendStationInput,
  type SystemHealth,
} from '@lookup/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { UuidOrNotFoundPipe } from '../../common/validation/uuid-or-not-found.pipe.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { AdminApplications } from './admin-applications.js';
import { AdminInsight } from './admin-insight.js';
import { AdminStations } from './admin-stations.js';
import { SuperAdminGuard } from './super-admin.guard.js';

/**
 * The super-admin console's API (P5A design §3.3; P5A-STRUCTURE-03). Every route needs a super admin whose session
 * passed the second factor; everyone else is answered as if it did not exist.
 */
@Controller('admin')
@UseGuards(SuperAdminGuard)
export class AdminController {
  constructor(
    private readonly applications: AdminApplications,
    private readonly stations: AdminStations,
    private readonly insight: AdminInsight,
  ) {}

  @Get('summary')
  async summary(): Promise<AdminSummary> {
    const [queue, overlaps] = await Promise.all([this.applications.readQueue(), this.insight.listAudioOverlaps()]);
    return {
      waitingApplicationCount: queue.entries.length,
      audioToCheckCount: overlaps.findings.filter((finding) => finding.reviewedAt === null).length,
    };
  }

  @Get('applications')
  applicationQueue(): Promise<ApplicationQueue> {
    return this.applications.readQueue();
  }

  @Get('applications/:stationId')
  application(@Param('stationId', new UuidOrNotFoundPipe()) stationId: string): Promise<ApplicationDetail> {
    return this.applications.readDetail(stationId);
  }

  @Post('applications/:stationId/licence-document-link')
  @HttpCode(200)
  licenceDocumentLink(@Param('stationId', new UuidOrNotFoundPipe()) stationId: string): Promise<PrivateFileLink> {
    return this.applications.createLicenceDocumentLink(stationId, null);
  }

  @Post('applications/:stationId/approval')
  @HttpCode(204)
  async approve(@Param('stationId', new UuidOrNotFoundPipe()) stationId: string, @Req() request: Request): Promise<void> {
    await this.applications.approve(stationId, requestIdOf(request));
  }

  @Post('applications/:stationId/rejection')
  @HttpCode(204)
  async reject(
    @Param('stationId', new UuidOrNotFoundPipe()) stationId: string,
    @Body(new ZodValidationPipe(RejectApplicationInput)) input: RejectApplicationInput,
    @Req() request: Request,
  ): Promise<void> {
    await this.applications.reject(stationId, input.reason, requestIdOf(request));
  }

  @Post('change-requests/:changeRequestId/licence-document-link')
  @HttpCode(200)
  async changeDocumentLink(@Param('changeRequestId', new UuidOrNotFoundPipe()) changeRequestId: string): Promise<PrivateFileLink> {
    return this.applications.createLicenceDocumentLink('', changeRequestId);
  }

  @Post('change-requests/:changeRequestId/approval')
  @HttpCode(204)
  async approveChange(@Param('changeRequestId', new UuidOrNotFoundPipe()) changeRequestId: string, @Req() request: Request): Promise<void> {
    await this.applications.approveChange(changeRequestId, requestIdOf(request));
  }

  @Post('change-requests/:changeRequestId/rejection')
  @HttpCode(204)
  async rejectChange(
    @Param('changeRequestId', new UuidOrNotFoundPipe()) changeRequestId: string,
    @Body(new ZodValidationPipe(RejectApplicationInput)) input: RejectApplicationInput,
    @Req() request: Request,
  ): Promise<void> {
    await this.applications.rejectChange(changeRequestId, input.reason, requestIdOf(request));
  }

  @Get('stations')
  searchStations(@Query(new ZodValidationPipe(AdminStationSearchInput)) input: AdminStationSearchInput): Promise<AdminStationList> {
    return this.stations.search(input);
  }

  @Post('stations/:stationId/suspension')
  @HttpCode(204)
  async suspend(
    @Param('stationId', new UuidOrNotFoundPipe()) stationId: string,
    @Body(new ZodValidationPipe(SuspendStationInput)) input: SuspendStationInput,
    @Req() request: Request,
  ): Promise<void> {
    await this.stations.suspend(stationId, input.reason, requestIdOf(request));
  }

  @Post('stations/:stationId/reactivation')
  @HttpCode(204)
  async reactivate(@Param('stationId', new UuidOrNotFoundPipe()) stationId: string, @Req() request: Request): Promise<void> {
    await this.stations.reactivate(stationId, requestIdOf(request));
  }

  @Get('audio-overlaps')
  audioOverlaps(): Promise<AudioOverlapList> {
    return this.insight.listAudioOverlaps();
  }

  @Post('audio-overlaps/:findingId/preview-links')
  @HttpCode(200)
  audioOverlapPreviews(@Param('findingId', new UuidOrNotFoundPipe()) findingId: string): Promise<AudioOverlapPreviewLinks> {
    return this.insight.createOverlapPreviewLinks(findingId);
  }

  @Post('audio-overlaps/:findingId/review')
  @HttpCode(204)
  async reviewAudioOverlap(
    @Param('findingId', new UuidOrNotFoundPipe()) findingId: string,
    @Body(new ZodValidationPipe(ReviewAudioOverlapInput)) input: ReviewAudioOverlapInput,
    @Req() request: Request,
  ): Promise<void> {
    await this.insight.reviewAudioOverlap(findingId, input.note, requestIdOf(request));
  }

  @Get('system-health')
  systemHealth(): Promise<SystemHealth> {
    return this.insight.readSystemHealth();
  }

  @Get('reference-codes/:code')
  referenceCode(@Param('code') code: string): Promise<ReferenceCodeSearchResult> {
    return this.insight.findByReferenceCode(code);
  }
}

function requestIdOf(request: Request): string {
  return (request as Request & { id?: string }).id ?? 'unknown';
}
