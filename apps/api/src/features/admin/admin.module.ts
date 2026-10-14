import { Module } from '@nestjs/common';
import { AdminApplications } from './admin-applications.js';
import { AdminController } from './admin.controller.js';
import { AdminInsight } from './admin-insight.js';
import { AdminStations } from './admin-stations.js';
import { SuperAdminGuard } from './super-admin.guard.js';

/** The super-admin console's API (P5A design §3.3; P5A-STRUCTURE-03), on the admin database connection only. */
@Module({
  controllers: [AdminController],
  providers: [AdminApplications, AdminStations, AdminInsight, SuperAdminGuard],
})
export class AdminModule {}
