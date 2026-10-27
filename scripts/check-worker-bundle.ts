import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { z } from 'zod';

// Modules that exist only for the Node profile (ADR-0009). workerd stubs
// node:sqlite and provides node:fs, so a Worker that loads one of these still
// starts, and a test under workerd does not notice; only the built bundle
// shows that the Worker reached them.
export const FORBIDDEN_MODULES = [
  'node:sqlite',
  'node:fs',
  'node:fs/promises',
  'umzug',
  '@hono/node-server',
  'playwright-core',
] as const;

// The parts of esbuild's metafile, which wrangler writes for the bundle,
// that the check reads: every source file bundled in, and each output's
// remaining imports, such as Node built-ins left to the runtime.
const importSchema = z.object({ external: z.boolean().optional(), path: z.string() });
const outputSchema = z.object({ imports: z.array(importSchema) });
const metafileSchema = z.object({
  inputs: z.record(z.string(), z.unknown()),
  outputs: z.record(z.string(), outputSchema),
});

export type Metafile = z.infer<typeof metafileSchema>;

// A built-in is matched with or without its `node:` prefix, since a package
// may import bare `fs`; a package is matched with its subpaths.
function importMatches(specifier: string, forbidden: string): boolean {
  const name = specifier.replace(/^node:/u, '');
  const banned = forbidden.replace(/^node:/u, '');
  return name === banned || name.startsWith(`${banned}/`);
}

// A package that esbuild inlined, found by its directory in node_modules.
function inputMatches(path: string, forbidden: string): boolean {
  return !forbidden.startsWith('node:') && `/${path}`.includes(`/node_modules/${forbidden}/`);
}

// Each forbidden module the bundle imports or inlines, with how it got in.
export function forbiddenImports(metafile: Metafile): string[] {
  const found = new Set<string>();
  for (const { imports } of Object.values(metafile.outputs)) {
    for (const { path } of imports) {
      for (const forbidden of FORBIDDEN_MODULES) {
        if (importMatches(path, forbidden)) {
          found.add(`${forbidden} (imports ${path})`);
        }
      }
    }
  }
  for (const path of Object.keys(metafile.inputs)) {
    for (const forbidden of FORBIDDEN_MODULES) {
      if (inputMatches(path, forbidden)) {
        found.add(`${forbidden} (bundled from node_modules)`);
      }
    }
  }
  return [...found].toSorted();
}

// Builds the Worker as `wrangler deploy` would, without uploading it, and
// reads its metafile. The assets directory must exist, so run `vite build`
// first; `pnpm worker:check` does.
async function buildMetafile(): Promise<Metafile> {
  const outdir = await mkdtemp(join(tmpdir(), 'muninn-worker-bundle-'));
  try {
    const metafilePath = join(outdir, 'meta.json');
    await promisify(execFile)(
      'wrangler',
      ['deploy', '--dry-run', '--outdir', outdir, '--metafile', metafilePath],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return metafileSchema.parse(JSON.parse(await readFile(metafilePath, 'utf8')));
  } finally {
    await rm(outdir, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  const found = forbiddenImports(await buildMetafile());
  if (found.length > 0) {
    throw new Error(
      `The Worker bundle reaches Node-only modules:\n${found.map((line) => `  ${line}`).join('\n')}`,
    );
  }
  process.stdout.write('The Worker bundle imports no Node-only modules.\n');
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
