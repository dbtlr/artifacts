import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The shared SQL migrations live in <repo root>/migrations, the directory
// `wrangler d1 migrations apply` reads by default. Resolved like
// src/data-dir.ts: the dev entry (this module) and the packed bundle
// (dist/server.js) both sit one directory below the repo root.
const moduleDir = dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = join(moduleDir, '..', 'migrations');
