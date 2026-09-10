import { config as loadEnvironment } from 'dotenv';
import { resolve } from 'node:path';
import { validateLocalProfile } from '@pulse-field/foundation';
import { createApiApp } from './create-api-app';
import { createLogger } from './logger';
import { startTelemetry } from './telemetry';

loadEnvironment({ path: resolve(process.cwd(), '.env') });
loadEnvironment({ path: resolve(process.cwd(), '../../.env') });

async function bootstrap(): Promise<void> {
  const profile = validateLocalProfile(process.env);
  const logger = createLogger(profile);
  const telemetry = startTelemetry(profile);
  const app = await createApiApp(profile);

  const host = process.env.API_BIND_HOST ?? '127.0.0.1';
  await app.listen(profile.API_PORT, host);
  logger.info({ host, port: profile.API_PORT }, 'PULSE//FIELD API foundation is listening');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down API foundation');
    await app.close();
    await telemetry.shutdown();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

void bootstrap().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : 'API bootstrap failed.'}\n`);
  process.exitCode = 1;
});
