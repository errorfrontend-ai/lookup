import { Controller, Get, Inject } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { AppError } from '../../common/errors/app-error.js';
import { KEY_VALUE_STORE } from '../../infrastructure/key-value-store/key-value-store.module.js';

@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(KEY_VALUE_STORE) private readonly keyValueStore: Redis,
  ) {}

  /** 200 when the database and key-value store both answer; otherwise a generic 503 (details logged). */
  @Get()
  async check(): Promise<{ status: 'ok' }> {
    const [databaseCheck, keyValueStoreCheck] = await Promise.allSettled([
      this.dataSource.query('SELECT 1'),
      this.keyValueStore.ping(),
    ]);
    if (databaseCheck.status === 'rejected' || keyValueStoreCheck.status === 'rejected') {
      throw new AppError('SERVICE_UNAVAILABLE', {
        internalDetail: `health: database=${databaseCheck.status} key_value_store=${keyValueStoreCheck.status}`,
        cause: databaseCheck.status === 'rejected' ? databaseCheck.reason : (keyValueStoreCheck as PromiseRejectedResult).reason,
      });
    }
    return { status: 'ok' };
  }
}
