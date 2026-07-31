import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

describe('direct runtime scripts', () => {
  it.each(['dev', 'start'] as const)('forces NODE_ENV=development for pnpm %s', async (name) => {
    const packageJson = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(JSON.parse(await readFile(packageJsonPath, 'utf8')));

    expect(packageJson.scripts[name]).toMatch(/^cross-env NODE_ENV=development /u);
  });
});
