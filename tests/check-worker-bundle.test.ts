import { describe, expect, it } from 'vite-plus/test';

import { forbiddenImports } from '../scripts/check-worker-bundle.js';
import type { Metafile } from '../scripts/check-worker-bundle.js';

function metafile({
  imports = [],
  inputs = [],
}: {
  imports?: string[];
  inputs?: string[];
}): Metafile {
  return {
    inputs: Object.fromEntries(inputs.map((path) => [path, {}])),
    outputs: {
      'worker.js': { imports: imports.map((path) => ({ external: true, path })) },
      'worker.js.map': { imports: [] },
    },
  };
}

describe('forbiddenImports', () => {
  it('accepts a bundle that imports only what the Worker may use', () => {
    expect(
      forbiddenImports(
        metafile({
          imports: ['node:crypto', 'node:buffer'],
          inputs: ['src/worker.ts', 'node_modules/.pnpm/hono@4/node_modules/hono/dist/index.js'],
        }),
      ),
    ).toEqual([]);
  });

  it('finds a Node built-in import, with or without its prefix', () => {
    expect(
      forbiddenImports(metafile({ imports: ['node:sqlite', 'fs/promises', 'node:crypto'] })),
    ).toEqual([
      'node:fs (imports fs/promises)',
      'node:fs/promises (imports fs/promises)',
      'node:sqlite (imports node:sqlite)',
    ]);
  });

  it('finds a Node-only package that the bundle inlined', () => {
    expect(
      forbiddenImports(
        metafile({
          inputs: [
            'node_modules/.pnpm/umzug@3.8.3/node_modules/umzug/lib/index.js',
            'node_modules/.pnpm/@hono+node-server@2.0.11/node_modules/@hono/node-server/dist/index.mjs',
            'node_modules/playwright-core/index.mjs',
          ],
        }),
      ),
    ).toEqual([
      '@hono/node-server (bundled from node_modules)',
      'playwright-core (bundled from node_modules)',
      'umzug (bundled from node_modules)',
    ]);
  });

  it('does not mistake a package whose name only starts the same way', () => {
    expect(
      forbiddenImports(
        metafile({
          imports: ['fsevents'],
          inputs: ['node_modules/umzug-extra/index.js', 'src/umzug/notes.ts'],
        }),
      ),
    ).toEqual([]);
  });
});
