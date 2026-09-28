import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APP_CONFIG } from './config';
import type { AppConfig } from './config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // On SIGTERM (e.g. systemctl stop), let an in-flight poll finish before exiting.
  app.enableShutdownHooks();
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.port);
}
bootstrap();
