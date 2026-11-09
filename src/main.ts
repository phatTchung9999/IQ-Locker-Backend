import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { AppModule, ObserveInstrument } from './app.module.js';
import { BlobStorageService } from './storage/blob-storage.service.js';

async function bootstrap() {
  const logger = new Logger('Startup');
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });
  app.enableCors();

  // Nest waits for Mongoose during creation; also verify the live connection
  // responds before announcing it as connected or accepting requests.
  const database = app.get<Connection>(getConnectionToken());
  try {
    if (database.readyState !== 1 || !database.db) throw new Error('Database not ready');
    await database.db.command({ ping: 1 });
    logger.log('MongoDB: connected');
  } catch {
    logger.error('MongoDB: connection check failed. Backend will not start.');
    await app.close();
    process.exitCode = 1;
    return;
  }

  const storage = app.get(BlobStorageService);
  const containers = ['materials', 'avatars'] as const;
  const results = await Promise.allSettled(containers.map(kind => storage.ensureReady(kind)));
  results.forEach((result, index) => {
    const label = index === 0 ? 'Materials' : 'Avatars';
    if (result.status === 'fulfilled') logger.log(`${label} container: private access verified`);
    else logger.warn(`${label} container: access check failed. Check configuration, credentials, permissions and private access. Backend will continue.`);
  });

  try {
    await app.listen(process.env.PORT ?? 3010);
    const address = app.getHttpServer().address();
    logger.log(`Backend: listening on port ${typeof address === 'object' && address ? address.port : process.env.PORT ?? 3010}`);
  } catch {
    logger.error('Backend: could not start listening.');
    await app.close();
    process.exitCode = 1;
  }
}
await bootstrap();
