import { access, readFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const errors: string[] = [];
  const gitignore = await readFile('.gitignore', 'utf8');
  const example = await readFile('.env.example', 'utf8');

  for (const requiredRule of ['.env', '.local/', '*.dump']) {
    if (!gitignore.includes(requiredRule)) errors.push(`.gitignore must protect ${requiredRule}.`);
  }

  if (/sk_(live|test)_[A-Za-z0-9]/.test(example) || /pk_(live|test)_[A-Za-z0-9]/.test(example)) {
    errors.push('.env.example contains a Stripe key-shaped value instead of a safe placeholder.');
  }

  if (/^\s*MESSAGE_ENCRYPTION_(?:PREVIOUS_)?KEY_BASE64\s*=/m.test(example)) {
    errors.push('.env.example must not contain a reusable message-encryption key.');
  }

  try {
    await access('.git');
    const { execFileSync } = await import('node:child_process');
    const tracked = execFileSync('git', ['ls-files', '.env', '.env.local', '.env.production'], {
      encoding: 'utf8',
    }).trim();
    if (tracked) errors.push(`Ignored environment file is tracked by Git: ${tracked}.`);
  } catch {
    // A new workspace can be validated before it is initialized as a Git repository.
  }

  if (errors.length > 0) throw new Error(`Secret-handling check failed:\n- ${errors.join('\n- ')}`);
  process.stdout.write(
    'Secret-handling check passed: local environment files and backups are excluded.\n',
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Secret-handling check failed.'}\n`,
  );
  process.exitCode = 1;
});
