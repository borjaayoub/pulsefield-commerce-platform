import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const backupDirectory = path.resolve('.local', 'backups');
await fs.mkdir(backupDirectory, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = path.join(backupDirectory, `pulsefield-${timestamp}.dump`);
const output = createWriteStream(destination, { flags: 'wx' });
const command = spawn(
  'docker',
  ['compose', 'exec', '-T', 'postgres', 'pg_dump', '-U', 'pulsefield', '--format=custom', 'pulsefield'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

command.stdout.pipe(output);
command.stderr.pipe(process.stderr);
command.once('error', async (error) => {
  await fs.rm(destination, { force: true });
  process.stderr.write(`Backup could not start: ${error.message}\n`);
  process.exitCode = 1;
});
command.once('close', async (code) => {
  if (code !== 0) {
    await fs.rm(destination, { force: true });
    process.stderr.write(`Backup failed with exit code ${code}.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Backup created: ${destination}\n`);
});
