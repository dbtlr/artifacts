const DEFAULT_BASE_URL = 'http://localhost:3000';

// Read lazily on every call (not cached at module scope) so tests can flip the
// public base URL between cases without a module reset. Owner auth also reads
// it: its origin is an allowed form Origin, and https makes cookies Secure.
export function resolvePublicBaseUrl(): string {
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
    url.password !== '' ||
    url.search !== '' ||
    url.username !== '' ||
    base === ''
  ) {
    throw new Error(
      `ARTIFACTS_PUBLIC_BASE_URL must be an absolute HTTP(S) URL, got ${JSON.stringify(raw)}`,
    );
  }
  return url.toString().replace(/\/+$/u, '');
}

// Whether an Origin header names this server, as the request reached it
// (`requestUrl`) or as its public base URL names it (they differ behind a
// proxy). `null`, from sandboxed artifacts, never does.
export function isOwnOrigin(origin: string, requestUrl: string): boolean {
  return origin === new URL(requestUrl).origin || origin === new URL(resolvePublicBaseUrl()).origin;
}

// The display route (/a/<id>) lands in a later task; this stays importable
// from there too so both the MCP layer and that route build identical URLs.
export function buildArtifactUrl(id: string): string {
  return `${resolvePublicBaseUrl()}/a/${id}`;
}
