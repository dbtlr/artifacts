const DEFAULT_BASE_URL = 'http://localhost:3000';

// Read lazily on every call (not cached at module scope) so tests can flip the
// public base URL between cases without a module reset.
function resolveBaseUrl(): string {
  const raw = process.env.ARTIFACTS_PUBLIC_BASE_URL;
  if (raw === undefined) {
    return DEFAULT_BASE_URL;
  }
  const base = raw.trim();
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(
      `ARTIFACTS_PUBLIC_BASE_URL must be an absolute HTTP(S) URL, got ${JSON.stringify(raw)}`,
    );
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.hash !== '' ||
    url.search !== '' ||
    base === ''
  ) {
    throw new Error(
      `ARTIFACTS_PUBLIC_BASE_URL must be an absolute HTTP(S) URL, got ${JSON.stringify(raw)}`,
    );
  }
  return base.replace(/\/+$/u, '');
}

// The display route (/a/<id>) lands in a later task; this stays importable
// from there too so both the MCP layer and that route build identical URLs.
export function buildArtifactUrl(id: string): string {
  return `${resolveBaseUrl()}/a/${id}`;
}
