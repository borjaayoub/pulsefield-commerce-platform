import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(__dirname, '../../../..');
const harness = path.join(root, 'scripts/run-phase5-acceptance.mjs');

describe('Phase 5 acceptance command safety', () => {
  it.each([['--config=other.cjs'], ['--full', '--force']])(
    'rejects unsupported arguments before preparing a database: %s',
    (...args: string[]) => {
      const result = spawnSync(process.execPath, [harness, ...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Usage: pnpm test:phase5 [--full]');
      expect(result.stdout).not.toContain('Preparing isolated database');
    },
  );

  it('rejects a remote development URL without connecting or printing its credentials', () => {
    const result = spawnSync(process.execPath, [harness], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, DATABASE_URL: 'postgresql://probe:private-probe@remote.invalid/dev' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL must point to a local PostgreSQL host.');
    expect(result.stdout).not.toContain('Preparing isolated database');
    expect(result.stderr + result.stdout).not.toContain('private-probe');
  });
});
