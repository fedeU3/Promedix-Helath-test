import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { APP_CONFIG } from '../config';
import type { AppConfig } from '../config';
import { EarthquakesRepository } from '../earthquakes/earthquakes.repository';
import { PollerService } from '../poller/poller.service';

/** Data older than this many poll intervals counts as stale. */
// With the default 5-minute interval, that's 15 minutes: one or two failed polls are
// normal blips, three in a row means something is actually wrong.
const STALE_AFTER_INTERVALS = 3;

@Controller('health')
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly repository: EarthquakesRepository,
    private readonly poller: PollerService,
  ) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    const database = await this.repository
      .ping()
      .then(() => 'up' as const)
      .catch(() => 'down' as const);

    const { lastSuccessAt } = this.poller.status;
    const staleAfterMs = this.config.pollIntervalMs * STALE_AFTER_INTERVALS;
    const stale =
      !lastSuccessAt || Date.now() - lastSuccessAt.getTime() > staleAfterMs;

    const healthy = database === 'up' && !stale;
    res.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: healthy ? 'ok' : 'degraded',
      database,
      stale,
      poller: this.poller.status,
    };
  }
}
