import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
require(path.join(root, 'node_modules/dotenv')).config({
  path: path.join(root, 'apps/api/.env'),
  quiet: true,
});
require(path.join(root, 'node_modules/dotenv')).config({
  path: path.join(root, '.env'),
  quiet: true,
});
const ts = require(path.join(root, 'node_modules/typescript'));

// Match the documented source-runner fallback. No package installation or TSX.
// Some Prisma seed imports use emitted .js names while this rehearsal runs source.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('.') && request.endsWith('.js') && parent?.filename) {
    const source = path.resolve(path.dirname(parent.filename), request.slice(0, -3) + '.ts');
    if (fs.existsSync(source)) return source;
  }
  return originalResolve.call(this, request, parent, ...rest);
};
require.extensions['.ts'] = (module, filename) => {
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
    }).outputText,
    filename,
  );
};
const load = (file) => require(path.join(root, file));

async function emptyRedisUrl() {
  const url = new URL(process.env.EPHEMERAL_REDIS_URL);
  if (url.protocol !== 'redis:' || !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Acceptance Redis must be loopback.');
  const originalDatabase = Number(url.pathname.slice(1));
  const Redis = load('apps/api/node_modules/ioredis');
  for (let index = 1; index <= 15; index++) {
    if (index === originalDatabase) continue;
    url.pathname = `/${index}`;
    const client = new Redis(url.href, { maxRetriesPerRequest: 1 });
    try {
      if ((await client.dbsize()) === 0) return url.href;
    } finally {
      await client.quit();
    }
  }
  throw new Error('No empty local Redis database available; no data is flushed.');
}
function saveResult(file, result) {
  const directory = path.join(root, '.local/acceptance');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, file), JSON.stringify(result));
}
export { root, load, emptyRedisUrl, saveResult };
