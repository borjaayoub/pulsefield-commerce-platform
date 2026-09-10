import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const environmentPath = resolve(process.cwd(), '.env');
const temporaryPath = `${environmentPath}.message-key.tmp`;
const variableName = 'MESSAGE_ENCRYPTION_KEY_BASE64';
const relayVariableName = 'OUTBOX_RELAY_ENABLED';
const canonicalKeyPattern = /^[A-Za-z0-9+/]{43}=$/;

async function main() {
  let source;
  try {
    source = await readFile(environmentPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error('Create .env from .env.example before generating local secrets.');
    }
    throw error;
  }

  const lines = source.split(/\r?\n/);
  const existingLine = lines.find((line) => line.startsWith(`${variableName}=`));
  const additions = [];

  if (existingLine) {
    const existingValue = existingLine.slice(variableName.length + 1);
    if (
      !canonicalKeyPattern.test(existingValue) ||
      Buffer.from(existingValue, 'base64').length !== 32
    ) {
      throw new Error(`${variableName} already exists but is not a valid 32-byte base64 key.`);
    }
  } else {
    additions.push(`${variableName}=${randomBytes(32).toString('base64')}`);
  }

  if (!lines.some((line) => line.startsWith(`${relayVariableName}=`))) {
    additions.push(`${relayVariableName}=true`);
  }

  if (additions.length === 0) {
    process.stdout.write('Local messaging configuration already exists; no change made.\n');
    return;
  }

  const separator = source.endsWith('\n') ? '' : '\n';
  const updated = `${source}${separator}${additions.join('\n')}\n`;
  await writeFile(temporaryPath, updated, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporaryPath, environmentPath);
  process.stdout.write('Prepared local messaging configuration in ignored .env.\n');
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Local secret generation failed.'}\n`,
  );
  process.exitCode = 1;
});
