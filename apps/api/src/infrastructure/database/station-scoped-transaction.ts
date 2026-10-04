import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ClsService } from 'nestjs-cls';
import type { DataSource, EntityManager } from 'typeorm';

/** Whose data a unit of work may touch. Defaults come from the signed-in request's context. */
export interface StationScope {
  stationId?: string;
  userId?: string;
}

/**
 * The only way station-scoped code touches the database. Each unit of work runs in a
 * transaction that first sets app.current_station_id and app.current_user_id with
 * set_config(..., true): the values last only for this transaction, so pooled connections never
 * carry one station's context into another request. Postgres row-level security then filters
 * every query by them; with no context set, policies match nothing (fail closed).
 */
@Injectable()
export class StationScopedTransaction {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly requestContext: ClsService,
  ) {}

  run<Result>(work: (database: EntityManager) => Promise<Result>, scope?: StationScope): Promise<Result> {
    const stationId = scope?.stationId ?? this.requestContext.get<string | undefined>('stationId') ?? '';
    const userId = scope?.userId ?? this.requestContext.get<string | undefined>('userId') ?? '';
    return this.dataSource.transaction(async (database) => {
      await database.query(
        `SELECT set_config('app.current_station_id', $1, true), set_config('app.current_user_id', $2, true)`,
        [stationId, userId],
      );
      return work(database);
    });
  }
}
