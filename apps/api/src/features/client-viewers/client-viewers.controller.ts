import { type ClientViewerAccessList, InviteClientViewerInput } from '@lookup/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { UuidOrNotFoundPipe } from '../../common/validation/uuid-or-not-found.pipe.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import type { RequestFacts } from '../authentication/authentication.service.js';
import { CHANGE_STATION_CONTENT, StationAccess } from '../stations/station-access.decorator.js';
import { StationAccessGuard } from '../stations/station-access.guard.js';
import { ClientViewerAccess } from './client-viewer-access.js';

/**
 * Who can view a client's adverts (ADR-006): every member sees it; owners and managers invite, send again, cancel and
 * remove, as they add clients and adverts.
 */
@Controller('stations/:stationId/clients/:clientId/viewers')
@UseGuards(StationAccessGuard)
export class ClientViewersController {
  constructor(private readonly access: ClientViewerAccess) {}

  @Get()
  read(@Param('clientId', new UuidOrNotFoundPipe()) clientId: string): Promise<ClientViewerAccessList> {
    return this.access.read(clientId);
  }

  @Post('invitations')
  @StationAccess(CHANGE_STATION_CONTENT)
  @HttpCode(201)
  invite(
    @Param('clientId', new UuidOrNotFoundPipe()) clientId: string,
    @Body(new ZodValidationPipe(InviteClientViewerInput)) input: InviteClientViewerInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ClientViewerAccessList> {
    return this.access.invite(clientId, input, requestFacts(request), response);
  }

  @Post('invitations/:invitationId/resending')
  @StationAccess(CHANGE_STATION_CONTENT)
  @HttpCode(200)
  resend(
    @Param('clientId', new UuidOrNotFoundPipe()) clientId: string,
    @Param('invitationId', new UuidOrNotFoundPipe()) invitationId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ClientViewerAccessList> {
    return this.access.resend(clientId, invitationId, requestFacts(request), response);
  }

  @Post('invitations/:invitationId/revocation')
  @StationAccess(CHANGE_STATION_CONTENT)
  @HttpCode(200)
  revoke(
    @Param('clientId', new UuidOrNotFoundPipe()) clientId: string,
    @Param('invitationId', new UuidOrNotFoundPipe()) invitationId: string,
    @Req() request: Request,
  ): Promise<ClientViewerAccessList> {
    return this.access.revoke(clientId, invitationId, requestFacts(request));
  }

  @Delete(':portalUserId')
  @StationAccess(CHANGE_STATION_CONTENT)
  remove(
    @Param('clientId', new UuidOrNotFoundPipe()) clientId: string,
    @Param('portalUserId', new UuidOrNotFoundPipe()) portalUserId: string,
    @Req() request: Request,
  ): Promise<ClientViewerAccessList> {
    return this.access.remove(clientId, portalUserId, requestFacts(request));
  }
}

function requestFacts(request: Request): RequestFacts {
  return { requestId: (request as Request & { id?: string }).id ?? 'unknown', clientAddress: request.ip ?? 'unknown' };
}
