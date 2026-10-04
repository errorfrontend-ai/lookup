import { BadRequestException, Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { AppError } from '../../src/common/errors/app-error.js';
import { RateLimit } from '../../src/common/rate-limiting/rate-limit.decorator.js';
import { ZodValidationPipe } from '../../src/common/validation/zod-validation.pipe.js';

const ValidatedInput = z.strictObject({
  name: z.string().min(1).max(50),
  count: z.number().int().min(0),
});

/** Test-only routes that fail in each way a real handler can. Never imported by the application itself. */
@Controller('test-only')
class FailureRoutesController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * A real Postgres error (SQLSTATE 23505, "duplicate key value violates unique constraint
   * listener_installs_install_id_hash_unique"), the kind that names tables and constraints. The
   * transaction rolls back, so nothing is left behind.
   */
  @Get('database-error')
  async databaseError(): Promise<void> {
    await this.dataSource.transaction(async (database) => {
      await database.query(
        `INSERT INTO app.listener_installs (install_id_hash, platform, app_version)
           VALUES ('\\x6c65616b'::bytea, 'ANDROID', 'test'), ('\\x6c65616b'::bytea, 'ANDROID', 'test')`,
      );
    });
  }

  /** A malformed id in a URL, the most common way a driver error reaches a handler. */
  @Get('malformed-id/:id')
  async malformedId(@Param('id') id: string): Promise<unknown> {
    return this.dataSource.query('SELECT id FROM app.listener_installs WHERE id = $1', [id]);
  }

  @Get('programming-error')
  programmingError(): unknown {
    const missing = undefined as unknown as { field: { deeper: string } };
    return missing.field.deeper;
  }

  @Get('app-error')
  appError(): never {
    throw new AppError('CONFLICT', { internalDetail: 'private detail: station 42 already has this ad' });
  }

  @Get('framework-error')
  frameworkError(): never {
    throw new BadRequestException('internal hint: column portal_users.password_hash');
  }

  @Post('echo')
  echo(@Body() body: unknown): unknown {
    return body;
  }

  @Post('validated')
  validated(@Body(new ZodValidationPipe(ValidatedInput)) body: z.infer<typeof ValidatedInput>): unknown {
    return body;
  }

  @Get('rate-limited')
  @RateLimit({ counterName: 'test-rate-limited', maximumRequests: 3, windowSeconds: 60 })
  rateLimited(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [FailureRoutesController] })
export class FailureRoutesModule {}
