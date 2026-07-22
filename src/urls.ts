const DEFAULT_BASE_URL = 'http://localhost:3000';

// Read lazily on every call (not cached at module scope) so tests can flip
// PUBLIC_BASE_URL between cases without a module reset, and so a Docker env
// change never requires a process restart to take effect.
function resolveBaseUrl(): string {
  const raw = process.env.PUBLIC_BASE_URL;
  const base = raw === undefined || raw.trim() === '' ? DEFAULT_BASE_URL : raw.trim();
  return base.replace(/\/+$/u, '');
}

// The display route (/a/<id>) lands in a later task; this stays importable
// from there too so both the MCP layer and that route build identical URLs.
export function buildArtifactUrl(id: string): string {
  return `${resolveBaseUrl()}/a/${id}`;
}
