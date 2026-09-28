import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PollerService } from '../poller/poller.service';
import { EarthquakesRepository } from './earthquakes.repository';

@Controller('earthquakes')
export class EarthquakesController {
  private readonly logger = new Logger(EarthquakesController.name);

  constructor(
    private readonly repository: EarthquakesRepository,
    private readonly poller: PollerService,
  ) { }

  /** GET /earthquakes?hours=24&limit=20 — largest quakes in the window. */
  @Get()
  async largest(
    @Query('hours') hours?: string,
    @Query('limit') limit?: string,
  ) {
    const h = parseBoundedInt('hours', hours, 24, 1, 168);
    const l = parseBoundedInt('limit', limit, 20, 1, 100);

    try {
      const earthquakes = await this.repository.findLargest(h, l);
      return {
        hours: h,
        dataAsOf: this.poller.status.lastSuccessAt,
        count: earthquakes.length,
        earthquakes,
      };
    } catch (err) {
      this.logger.error(`Query failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException('Database unavailable');
    }
  }
}

function parseBoundedInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new BadRequestException(
      `"${name}" must be an integer between ${min} and ${max}`,
    );
  }
  return n;
}
