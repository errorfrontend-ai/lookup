import { BadRequestException, Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { AppError } from '../../src/common/errors/app-error.js';
import { RateLimit } from '../../src/common/rate-limiting/rate-limit.decorator.js';
import { ZodValidationPipe } from '../../src/common/validation/zod-validation.pipe.js';
import { PublicRoute } from '../../src/features/authentication/public-route.decorator.js';

/** Personal values the database-error routes send as query parameters; none may reach a log line. */
export const PERSONAL_VALUES_SENT_TO_THE_DATABASE = {
  email: 'chanda.mwale@example.test',
  phoneNumber: '0977123456',
  passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA',
} as const;

const ValidatedInput = z.strictObject({
  name: z.string().min(1).max(50),
  count: z.number().int().min(0),
});

/** Test-only routes that fail in each way a real handler can. Never imported by the application itself. */
@Controller('test-only')
@PublicRoute()
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

  /**
   * A query that fails while carrying personal values: TypeORM keeps them in `parameters`, and
   * Postgres quotes the rejected one in its message (`invalid input syntax for type uuid: "…"`).
   */
  @Get('database-error-with-personal-values')
  async databaseErrorWithPersonalValues(): Promise<unknown> {
    const { email, passwordHash } = PERSONAL_VALUES_SENT_TO_THE_DATABASE;
    return this.dataSource.query('SELECT $1::text AS email, $2::text AS password_hash, $3::uuid AS id', [email, passwordHash, email]);
  }

  /** A check violation, whose driver `detail` repeats the whole failing row ("Failing row contains …"). */
  @Get('failing-row-with-personal-values')
  async failingRowWithPersonalValues(): Promise<void> {
    const { email, phoneNumber } = PERSONAL_VALUES_SENT_TO_THE_DATABASE;
    await this.dataSource.transaction(async (database) => {
      await database.query(
        `INSERT INTO app.listener_installs (install_id_hash, platform, app_version) VALUES (decode('6c65616b', 'hex'), 'NOT_A_PLATFORM', $1)`,
        [`${phoneNumber} ${email}`],
      );
    });
  }

  /** A caller-facing refusal (409) caused by a database error that carries personal values. */
  @Get('conflict-caused-by-database-error')
  async conflictCausedByDatabaseError(): Promise<void> {
    const { email } = PERSONAL_VALUES_SENT_TO_THE_DATABASE;
    try {
      await this.dataSource.transaction(async (database) => {
        await database.query(
          `INSERT INTO app.listener_installs (install_id_hash, platform, app_version)
             VALUES (decode('6c65616b', 'hex'), 'ANDROID', $1), (decode('6c65616b', 'hex'), 'ANDROID', $1)`,
          [email],
        );
      });
    } catch (error) {
      throw new AppError('CONFLICT', { internalDetail: 'duplicate install', cause: error });
    }
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

/** Test-only routes behind sign-in, so log lines carry the signed-in actor. */
@Controller('test-only/signed-in')
class SignedInFailureRoutesController {
  @Get('programming-error')
  programmingError(): unknown {
    const missing = undefined as unknown as { field: string };
    return missing.field;
  }
}

@Module({ controllers: [FailureRoutesController, SignedInFailureRoutesController] })
export class FailureRoutesModule {}
