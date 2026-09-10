import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

type ComposeDocument = {
  services?: Record<string, { image?: string; environment?: Record<string, string>; volumes?: string[] }>;
  volumes?: Record<string, unknown>;
};

const requiredServices = ['postgres', 'redis-queue', 'redis-cache', 'mailpit', 'jaeger'];
const requiredVolumes = ['postgres_data', 'redis_queue_data', 'product_media_data'];

async function main(): Promise<void> {
  const document = parse(await readFile('compose.yaml', 'utf8')) as ComposeDocument;
  const errors: string[] = [];

  for (const serviceName of requiredServices) {
    if (!document.services?.[serviceName]) errors.push(`Missing required local service: ${serviceName}.`);
  }
  for (const volumeName of requiredVolumes) {
    if (!document.volumes || !(volumeName in document.volumes)) {
      errors.push(`Missing required named volume: ${volumeName}.`);
    }
  }

  const services = document.services ?? {};
  if (services['redis-queue']?.image === services['redis-cache']?.image && !services['redis-queue']?.volumes?.length) {
    errors.push('Queue Redis must use a dedicated persistent volume.');
  }

  const prohibited = ['vercel', 'railway', 'neon', 'redis cloud', 'auth0', 'cloudinary', 'posthog', 'resend'];
  for (const [serviceName, service] of Object.entries(services)) {
    const serialized = JSON.stringify(service).toLowerCase();
    for (const provider of prohibited) {
      if (serialized.includes(provider)) errors.push(`${serviceName} references prohibited hosted provider ${provider}.`);
    }
  }

  if (errors.length > 0) throw new Error(`Compose topology validation failed:\n- ${errors.join('\n- ')}`);
  process.stdout.write('Compose topology validation passed: PostgreSQL, two Redis instances, Mailpit, Jaeger, and media volume are local.\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Compose topology validation failed.'}\n`);
  process.exitCode = 1;
});
