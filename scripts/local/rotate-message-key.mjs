import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const environmentPath = resolve(process.cwd(), '.env');
const temporaryPath = `${environmentPath}.message-key-rotation.tmp`;
const activeName = 'MESSAGE_ENCRYPTION_KEY_BASE64';
const previousName = 'MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64';
const canonicalKeyPattern = /^[A-Za-z0-9+/]{43}=$/;

function readSingleValue(lines, name) {
  const matches = lines.filter((line) => line.startsWith(`${name}=`));
  if (matches.length !== 1) throw new Error(`${name} must appear exactly once in .env.`);
  const value = matches[0].slice(name.length + 1);
  if (!canonicalKeyPattern.test(value) || Buffer.from(value, 'base64').length !== 32) {
    throw new Error(`${name} must be a valid 32-byte base64 key.`);
  }
  return value;
}

async function main() {
  let source;
  try {
    source = await readFile(environmentPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error('Create .env from .env.example before rotating the local message key.');
    }
    throw error;
  }

  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const current = readSingleValue(lines, activeName);
  if (lines.some((line) => line.startsWith(`${previousName}=`))) {
    throw new Error(
      'A previous message key is already configured; complete or recover that rotation first.',
    );
  }

  const replacement = randomBytes(32).toString('base64');
  const activeIndex = lines.findIndex((line) => line.startsWith(`${activeName}=`));
  lines.splice(activeIndex, 1, `${activeName}=${replacement}`, `${previousName}=${current}`);
  const updated = lines.join(newline);
  await writeFile(temporaryPath, updated, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporaryPath, environmentPath);
  process.stdout.write(
    'Started local message-key rotation. Re-encrypt TOTP secrets and drain queues before removing the previous key.\n',
  );
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Local message-key rotation could not start.'}\n`,
  );
  process.exitCode = 1;
});
