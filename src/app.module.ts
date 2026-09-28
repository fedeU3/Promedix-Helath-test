import { Module } from '@nestjs/common';
import { AppConfigModule } from './config';
import { DatabaseModule } from './database/database.module';
import { EarthquakesController } from './earthquakes/earthquakes.controller';
import { EarthquakesRepository } from './earthquakes/earthquakes.repository';
import { HealthController } from './health/health.controller';
import { PollerService } from './poller/poller.service';
import { UsgsClient } from './usgs/usgs.client';

@Module({
  imports: [AppConfigModule, DatabaseModule],
  controllers: [EarthquakesController, HealthController],
  providers: [
    EarthquakesRepository,
    PollerService,
    { provide: UsgsClient, useFactory: () => new UsgsClient() },
  ],
})
export class AppModule {}
