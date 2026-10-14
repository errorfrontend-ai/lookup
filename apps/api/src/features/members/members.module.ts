import { Module } from '@nestjs/common';
import { AuthenticationModule } from '../authentication/authentication.module.js';
import { InvitationsController, StationTeamController } from './members.controller.js';
import { StationTeams } from './station-team.js';

/** A station's team and its invitations (P5A design §3.3; P5A-STRUCTURE-02). */
@Module({
  imports: [AuthenticationModule],
  controllers: [StationTeamController, InvitationsController],
  providers: [StationTeams],
})
export class MembersModule {}
