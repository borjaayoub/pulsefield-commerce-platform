import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

interface ModuleDefinition {
  name: string;
  path: string;
  package: string;
  allowedWorkspaceDependencies: string[];
}

interface BoundaryConfig {
  modules: ModuleDefinition[];
  forbiddenImports: Record<string, string[]>;
  forbiddenSourcePatterns: Record<string, string[]>;
}

const importPattern = /(?:from\s+|import\s*\(|require\s*\()(['"])([^'"]+)\1/g;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', '.next', 'coverage'].includes(entry.name)) {
          return [];
        }
        return sourceFiles(absolute);
      }
      return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.spec.ts') ? [absolute] : [];
    }),
  );
  return files.flat();
}

function importsFrom(source: string): string[] {
  return [...source.matchAll(importPattern)].map((match) => match[2]);
}

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const config = JSON.parse(
    await readFile(path.join(workspaceRoot, 'architecture', 'module-boundaries.json'), 'utf8'),
  ) as BoundaryConfig;
  const workspacePackages = new Map(config.modules.map((module) => [module.package, module]));
  const errors: string[] = [];

  for (const module of config.modules) {
    const moduleDirectory = path.join(workspaceRoot, module.path);
    const files = await sourceFiles(moduleDirectory);
    const forbiddenImports = config.forbiddenImports[module.path] ?? [];
    const forbiddenPatterns = config.forbiddenSourcePatterns[module.path] ?? [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const relativeFile = path.relative(workspaceRoot, file);

      for (const importedPackage of importsFrom(source)) {
        const target = workspacePackages.get(importedPackage);
        if (target && !module.allowedWorkspaceDependencies.includes(importedPackage)) {
          errors.push(`${relativeFile} imports ${importedPackage}, which ${module.name} is not allowed to depend on.`);
        }
        if (forbiddenImports.includes(importedPackage)) {
          errors.push(`${relativeFile} imports forbidden dependency ${importedPackage}.`);
        }
      }

      for (const forbiddenPattern of forbiddenPatterns) {
        if (new RegExp(forbiddenPattern).test(source)) {
          errors.push(`${relativeFile} contains forbidden source pattern ${forbiddenPattern}.`);
        }
      }
    }
  }

  const adjacency = new Map(
    config.modules.map((module) => [
      module.package,
      module.allowedWorkspaceDependencies.filter((dependency) => workspacePackages.has(dependency)),
    ]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const checkCycle = (packageName: string, trail: string[]): void => {
    if (visiting.has(packageName)) {
      errors.push(`Workspace dependency cycle: ${[...trail, packageName].join(' -> ')}`);
      return;
    }
    if (visited.has(packageName)) return;

    visiting.add(packageName);
    for (const dependency of adjacency.get(packageName) ?? []) {
      checkCycle(dependency, [...trail, packageName]);
    }
    visiting.delete(packageName);
    visited.add(packageName);
  };

  for (const packageName of adjacency.keys()) checkCycle(packageName, []);

  if (errors.length > 0) {
    throw new Error(`Module boundary check failed:\n- ${errors.join('\n- ')}`);
  }
  process.stdout.write(`Module boundary check passed for ${config.modules.length} workspace modules.\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Module boundary check failed.'}\n`);
  process.exitCode = 1;
});
