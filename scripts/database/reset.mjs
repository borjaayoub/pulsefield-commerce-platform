import { config as loadEnvironment } from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnPnpm } from './pnpm-launcher.mjs';

loadEnvironment({ path: path.resolve('.env') });
const args = process.argv.slice(2);
const confirmation = args.find((argument) => argument.startsWith('--confirm='));
const acknowledged = args.includes('--acknowledge-no-backup');
const backupArgument = args.find((argument) => argument.startsWith('--backup='));
const databaseUrl = process.env.DATABASE_URL;
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
function databaseName(url) {
  try {
    const parsed = new URL(url);
    if (!['localhost', '127.0.0.1', 'postgres'].includes(parsed.hostname))
      throw new Error('remote');
    const name = decodeURIComponent(parsed.pathname.replace(/^\//u, '')).split('/')[0];
    if (!/^[a-z][a-z0-9_]{0,62}$/u.test(name)) throw new Error('name');
    return name;
  } catch {
    throw new Error(
      'DATABASE_URL must target a loopback PostgreSQL database with a safe database name.',
    );
  }
}
try {
  if (!confirmation || !/^--confirm=[a-z][a-z0-9_]{0,62}$/u.test(confirmation))
    throw new Error('Reset requires the exact database name: --confirm=<databaseName>.');
  if (!databaseUrl) throw new Error('DATABASE_URL is required before reset preflight.');
  const targetName = databaseName(databaseUrl);
  const expectedName = confirmation.slice('--confirm='.length);
  if (targetName !== expectedName)
    throw new Error(`Reset confirmation does not match DATABASE_URL (${targetName}).`);
  if (targetName === 'pulsefield' || targetName === 'postgres' || targetName === 'template1')
    throw new Error(
      'The primary/default PostgreSQL database is protected. Use a disposable *_test or *_reset_test database.',
    );
  if (!targetName.endsWith('_test') && !targetName.endsWith('_reset_test'))
    throw new Error('Reset is permitted only for an explicitly disposable *_test database.');
  if (backupArgument) {
    const backup = path.resolve(backupArgument.slice('--backup='.length));
    const relative = path.relative(path.resolve('.local', 'backups'), backup);
    if (
      !relative ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      !relative.endsWith('.dump') ||
      !existsSync(backup)
    )
      throw new Error('Backup must be an existing .dump file under .local/backups.');
  } else if (!acknowledged)
    throw new Error(
      'Reset requires --backup=.local/backups/<file>.dump or --acknowledge-no-backup.',
    );
  if (!process.env.PHASE3_DEMO_ADMIN_PASSWORD || !process.env.PHASE3_DEMO_FULFILLER_PASSWORD)
    throw new Error(
      'Reset preflight requires demo staff passwords in the ignored environment; no deletion was attempted.',
    );
  const child = spawnPnpm(
    ['--filter', '@pulse-field/api', 'exec', 'prisma', 'migrate', 'reset', '--force'],
    { stdio: 'inherit', env: { ...process.env, PHASE3_DEMO_MODE: 'true' } },
  );
  child.once('error', (error) => fail(`Reset could not start: ${error.message}`));
  child.once('close', (code) => {
    if (code === 0)
      process.stdout.write(
        `Disposable database ${targetName} reset and deterministically seeded.\n`,
      );
    else process.exitCode = code ?? 1;
  });
} catch (error) {
  fail(error instanceof Error ? error.message : 'Reset preflight failed.');
}
