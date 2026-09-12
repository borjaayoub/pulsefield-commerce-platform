import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function validPnpmCli(candidate) {
  try {
    return statSync(candidate).isFile() && /^pnpm(?:\.[cm]?js)?$/iu.test(path.basename(candidate));
  } catch {
    return false;
  }
}

export function resolvePnpmInvocation({
  env = process.env,
  platform = process.platform,
  cwd = process.cwd(),
  execPath = process.execPath,
} = {}) {
  const configuredPath = env.npm_execpath?.trim();
  if (configuredPath) {
    const candidate = path.resolve(cwd, configuredPath);
    if (existsSync(candidate) && validPnpmCli(candidate))
      return { command: execPath, prefixArgs: [candidate], shell: false };
  }
  return {
    command: platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    prefixArgs: [],
    // The reset caller supplies a fixed argument list; Windows requires shell
    // execution to launch the pnpm.cmd shim from a Node child process.
    shell: platform === 'win32',
  };
}

export function spawnPnpm(args, options = {}) {
  const invocation = resolvePnpmInvocation(options);
  return spawn(invocation.command, [...invocation.prefixArgs, ...args], {
    ...options,
    shell: invocation.shell,
  });
}
