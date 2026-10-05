import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { EntityManager } from 'typeorm';

export interface AuditEntry {
  /** What happened, past tense with underscores, e.g. "client_created", "ad_published". */
  action: string;
  /** What it happened to, e.g. "client", "ad", "campaign". */
  entityType: string;
  entityId: string;
  /** The fields that changed. Never secrets, tokens, passwords or personal contact details. */
  changes?: Record<string, unknown>;
}

/**
 * Records who changed what, inside the same transaction as the change, so a change and its audit row
 * are saved together or not at all. Rows go to the station in the request context; the database only
 * lets the API append them (no update, no delete).
 */
@Injectable()
export class AuditTrail {
  constructor(private readonly requestContext: ClsService) {}

  async record(database: EntityManager, entry: AuditEntry): Promise<void> {
    await database.query(
      `INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id)
       VALUES (app.current_station_id(), app.current_user_id(), $1, $2, $3, $4, $5)`,
      [entry.action, entry.entityType, entry.entityId, entry.changes ? JSON.stringify(entry.changes) : null, this.requestContext.getId()],
    );
  }
}
