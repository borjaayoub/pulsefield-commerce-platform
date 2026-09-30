// Run the fixed set of quality validators without tsx's OS-account lookup.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const moduleRequire = createRequire(import.meta.url);

const allowedTools = new Set([
  'validate-env',
  'check-boundaries',
  'validate-compose',
  'check-secret-handling',
]);
const tool = process.argv[2];

if (!allowedTools.has(tool) || process.argv.length !== 3) {
  process.stderr.write('Usage: node scripts/run-quality-tool.mjs <quality-validator>\n');
  process.exit(1);
}

// Compile in memory at the original path so workspace dependency resolution is
// preserved. Strict typechecking remains a separate step in pnpm quality.
moduleRequire.extensions['.ts'] = (module, filename) => {
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  });
  module._compile(result.outputText, filename);
};

moduleRequire(path.resolve(import.meta.dirname, '..', 'tools', `${tool}.ts`));
