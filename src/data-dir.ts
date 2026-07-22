import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mirrors src/app.tsx's STATIC_ROOT resolution: both the dev entry (this
// module) and the packed bundle (dist/server.js) live exactly one directory
// below the repo root, so `../data` reaches the same directory from either
// location regardless of process.cwd(). Kept out of src/data/ on purpose —
// tsdown bundles local imports into a single dist/server.js, which collapses
// any deeper nesting, so only a module already one level below root resolves
// correctly in both dev and the packed build. ARTIFACTS_DATA_DIR overrides it
// outright for deployments with a different layout (e.g. a Docker bind mount).
const moduleDir = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DATA_DIR = process.env.ARTIFACTS_DATA_DIR ?? join(moduleDir, '..', 'data');
