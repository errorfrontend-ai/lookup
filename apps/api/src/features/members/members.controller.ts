import {
  type AcceptedInvitation,
  AcceptInvitationWithNewAccountInput,
  type InvitationDescription,
  InvitationTokenInput,
  InviteStationMemberInput,
  type StationTeam,
} from '@lookup/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RateLimit } from '../../common/rate-limiting/rate-limit.decorator.js';
import { UuidOrNotFoundPipe } from '../../common/validation/uuid-or-not-found.pipe.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import type { RequestFacts } from '../authentication/authentication.service.js';
import { PublicRoute } from '../authentication/public-route.decorator.js';
import { StationAccess, type StationAccessRequirement } from '../stations/station-access.decorator.js';
import { StationAccessGuard } from '../stations/station-access.guard.js';
import { INVITATION_LINKS_PER_ADDRESS, StationTeams } from './station-team.js';

/** Any member sees the team; managing it is an owner's, at an approved station (MANAGE_STATION_TEAM, P5A design §3.3). */
const READ_TEAM: StationAccessRequirement = { allowedRoles: ['OWNER', 'MANAGER', 'ANALYST'], requiresActiveStation: false };
const MANAGE_STATION_TEAM: StationAccessRequirement = { allowedRoles: ['OWNER'], requiresActiveStation: true };

@Controller('stations/:stationId')
@UseGuards(StationAccessGuard)
export class StationTeamController {
  constructor(private readonly teams: StationTeams) {}

  @Get('members')
  @StationAccess(READ_TEAM)
  read(): Promise<StationTeam> {
    return this.teams.read();
  }

  @Post('invitations')
  @StationAccess(MANAGE_STATION_TEAM)
  @HttpCode(201)
  invite(
    @Body(new ZodValidationPipe(InviteStationMemberInput)) input: InviteStationMemberInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StationTeam> {
    return this.teams.invite(input, requestFacts(request), response);
  }

  @Post('invitations/:invitationId/revocation')
  @StationAccess(MANAGE_STATION_TEAM)
  @HttpCode(200)
  revoke(@Param('invitationId', new UuidOrNotFoundPipe()) invitationId: string, @Req() request: Request): Promise<StationTeam> {
    return this.teams.revoke(invitationId, requestFacts(request));
  }

  @Delete('members/:portalUserId')
  @StationAccess(MANAGE_STATION_TEAM)
  remove(@Param('portalUserId', new UuidOrNotFoundPipe()) portalUserId: string, @Req() request: Request): Promise<StationTeam> {
    return this.teams.removeMember(portalUserId, requestFacts(request));
  }
}

/** The invitee's side: the link describes itself to anyone; joining needs a new account or the invited email signed in. */
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly teams: StationTeams) {}

  @Post('description')
  @PublicRoute()
  @RateLimit(INVITATION_LINKS_PER_ADDRESS)
  @HttpCode(200)
  describe(@Body(new ZodValidationPipe(InvitationTokenInput)) input: InvitationTokenInput): Promise<InvitationDescription> {
    return this.teams.describeInvitation(input.token);
  }

  @Post('acceptance-with-new-account')
  @PublicRoute()
  @RateLimit(INVITATION_LINKS_PER_ADDRESS)
  @HttpCode(201)
  acceptWithNewAccount(
    @Body(new ZodValidationPipe(AcceptInvitationWithNewAccountInput)) input: AcceptInvitationWithNewAccountInput & { mobileNumber: string | null },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AcceptedInvitation> {
    return this.teams.acceptWithNewAccount(input, requestFacts(request), response);
  }

  @Post('acceptance')
  @RateLimit(INVITATION_LINKS_PER_ADDRESS)
  @HttpCode(200)
  accept(@Body(new ZodValidationPipe(InvitationTokenInput)) input: InvitationTokenInput, @Req() request: Request): Promise<AcceptedInvitation> {
    return this.teams.acceptSignedIn(input.token, requestFacts(request));
  }
}

function requestFacts(request: Request): RequestFacts {
  return { requestId: (request as Request & { id?: string }).id ?? 'unknown', clientAddress: request.ip ?? 'unknown' };
}
