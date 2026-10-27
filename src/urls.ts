import { resolvePort } from './port.js';

// Read lazily on every call (not cached at module scope) so tests can flip the
// public base URL between cases without a module reset. Owner auth also reads
// it: its origin is an allowed form Origin, and https makes cookies Secure.
// Unset, the base URL follows MUNINN_PORT and goes through the same
// normalization, so one setting moves the listener and the links together. An
// invalid MUNINN_PORT throws the same error as startup.
export function resolvePublicBaseUrl(): string {
  const raw =
    process.env.MUNINN_PUBLIC_BASE_URL ??
    `http://localhost:${String(resolvePort(process.env.MUNINN_PORT))}`;
  const base = raw.trim();
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(
      `MUNINN_PUBLIC_BASE_URL must be an absolute HTTP(S) URL, got ${JSON.stringify(raw)}`,
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
      `MUNINN_PUBLIC_BASE_URL must be an absolute HTTP(S) URL, got ${JSON.stringify(raw)}`,
    );
  }
  return url.toString().replace(/\/+$/u, '');
}

// Whether an Origin header names this server, as the request reached it
// (`requestUrl`) or as a configured public base URL names it (they differ
// behind a proxy). The default base URL is not trusted: it is a guess from
// MUNINN_PORT that knows nothing of the real host or a container's port
// mapping. `null`, from sandboxed artifacts, never matches.
export function isOwnOrigin(origin: string, requestUrl: string): boolean {
  return (
    origin === new URL(requestUrl).origin ||
    (process.env.MUNINN_PUBLIC_BASE_URL !== undefined &&
      origin === new URL(resolvePublicBaseUrl()).origin)
  );
}

// The display route (/a/<id>) lands in a later task; this stays importable
// from there too so both the MCP layer and that route build identical URLs.
export function buildArtifactUrl(id: string): string {
  return `${resolvePublicBaseUrl()}/a/${id}`;
}

// A one-time secret's single-use upload URL (ADR-0008).
export function buildSecretUploadUrl(uploadToken: string): string {
  return `${resolvePublicBaseUrl()}/s/upload/${uploadToken}`;
}

// A one-time secret's view link. The key is in the fragment, so a browser
// never sends it to the server or puts it in a Referer.
export function buildSecretViewUrl(id: string, key: string): string {
  return `${resolvePublicBaseUrl()}/s/${id}#${key}`;
}
