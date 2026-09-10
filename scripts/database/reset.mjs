import { spawn } from 'node:child_process';

if (!process.argv.includes('--confirm')) {
  process.stderr.write('Reset destroys the local database. Re-run with --confirm.\n');
  process.exitCode = 1;
} else {
  const command = spawn(
    'pnpm',
    ['--filter', '@pulse-field/api', 'exec', 'prisma', 'migrate', 'reset', '--force'],
    { stdio: 'inherit' },
  );
  command.once('error', (error) => {
    process.stderr.write(`Reset could not start: ${error.message}\n`);
    process.exitCode = 1;
  });
  command.once('close', (code) => {
    if (code === 0) process.stdout.write('Database reset and deterministic foundation seed completed.\n');
    else process.exitCode = code ?? 1;
  });
}
