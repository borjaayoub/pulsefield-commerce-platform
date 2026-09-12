import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolvePnpmInvocation, spawnPnpm } from './pnpm-launcher.mjs';

test('uses the validated current pnpm CLI through Node on Windows', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pulsefield-pnpm-'));
  const cli = path.join(directory, 'pnpm.cjs');
  writeFileSync(cli, '// test fixture');
  try {
    assert.deepEqual(
      resolvePnpmInvocation({
        cwd: directory,
        env: { npm_execpath: cli },
        execPath: 'node-test',
        platform: 'win32',
      }),
      { command: 'node-test', prefixArgs: [cli], shell: false },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('falls back to the platform pnpm executable when npm_execpath is absent', () => {
  assert.deepEqual(resolvePnpmInvocation({ env: {}, platform: 'win32' }), {
    command: 'pnpm.cmd',
    prefixArgs: [],
    shell: true,
  });
  assert.deepEqual(resolvePnpmInvocation({ env: {}, platform: 'linux' }), {
    command: 'pnpm',
    prefixArgs: [],
    shell: false,
  });
});

test(
  'launches the Windows pnpm shim with the safe fallback',
  { skip: process.platform !== 'win32' },
  async () => {
    const child = spawnPnpm(['--version'], {
      env: { ...process.env, npm_execpath: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errorOutput = '';
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      errorOutput += String(chunk);
    });
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(exitCode, 0, errorOutput);
    assert.match(output, /\d+\.\d+/u);
  },
);
