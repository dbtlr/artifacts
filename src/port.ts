// The direct-run default for MUNINN_PORT (`pnpm dev`, `node dist/server.js`),
// like the development storage paths in data-dir.ts. The Docker image and
// helper set 4242 instead, so a dev server and a container on one host do not
// collide. Either way MUNINN_PORT is the one setting: the default public base
// URL follows it.
export const DEFAULT_PORT = 4243;
const MAX_PORT = 65_535;

// Strict MUNINN_PORT parsing: unset or blank falls back
// to the default, but anything else present must be a valid port — including 0
// (OS-assigned), which `raw || DEFAULT` would otherwise silently coerce away,
// and garbage, which must fail loudly rather than fall back to a port nobody
// asked for.
export function resolvePort(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return DEFAULT_PORT;
  }
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error(`MUNINN_PORT must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  const port = Number(trimmed);
  if (!Number.isSafeInteger(port) || port > MAX_PORT) {
    throw new Error(
      `MUNINN_PORT must be between 0 and ${String(MAX_PORT)}, got ${JSON.stringify(raw)}`,
    );
  }
  return port;
}
