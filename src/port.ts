const DEFAULT_PORT = 3000;
const MAX_PORT = 65_535;

// Strict ARTIFACTS_PORT parsing: unset or blank falls back
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
    throw new Error(`ARTIFACTS_PORT must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  const port = Number(trimmed);
  if (!Number.isSafeInteger(port) || port > MAX_PORT) {
    throw new Error(
      `ARTIFACTS_PORT must be between 0 and ${String(MAX_PORT)}, got ${JSON.stringify(raw)}`,
    );
  }
  return port;
}
