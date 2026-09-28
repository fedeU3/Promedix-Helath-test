import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Pool } from 'pg';
import { APP_CONFIG } from '../config';
import type { AppConfig } from '../config';

export const PG_POOL = Symbol('PG_POOL');

export function createPool(databaseUrl: string): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    // pg waits forever for a connection by default. If the database is unreachable,
    // fail the poll fast instead of hanging it.
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  });
  pool.on('error', (err) =>
    // An idle connection can drop (DB restart, network blip). pg removes it from the
    // pool and emits 'error'; without this listener, that event crashes Node.
    new Logger('Database').warn(`Idle client error: ${err.message}`),
  );
  return pool;
}
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createPool(config.databaseUrl),
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown() {
    await this.pool.end();
  }
}
