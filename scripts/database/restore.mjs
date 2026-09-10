import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

if (!process.argv.includes('--confirm')) {
  process.stderr.write('Restore is destructive. Re-run with --confirm and a backup path.\n');
  process.exitCode = 1;
} else {
  const input = process.argv.find((argument) => argument.endsWith('.dump'));
  const backupDirectory = path.resolve('.local', 'backups');
  const source = input ? path.resolve(input) : '';
  const relative = source ? path.relative(backupDirectory, source) : '..';

  if (!input || relative.startsWith('..') || path.isAbsolute(relative)) {
    process.stderr.write('Restore requires a .dump file inside .local/backups.\n');
    process.exitCode = 1;
  } else {
    await fs.access(source);
    const command = spawn(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'postgres',
        'pg_restore',
        '-U',
        'pulsefield',
        '--clean',
        '--if-exists',
        '--no-owner',
        '--dbname=pulsefield',
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    command.stdin.write(await fs.readFile(source));
    command.stdin.end();
    command.once('error', (error) => {
      process.stderr.write(`Restore could not start: ${error.message}\n`);
      process.exitCode = 1;
    });
    command.once('close', (code) => {
      if (code === 0) process.stdout.write(`Restored: ${source}\n`);
      else {
        process.stderr.write(`Restore failed with exit code ${code}.\n`);
        process.exitCode = 1;
      }
    });
  }
}
