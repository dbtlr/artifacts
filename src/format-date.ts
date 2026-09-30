// Fixed locale/options keep server-rendered dates deterministic regardless of
// the host's configured locale — shared by every component that displays an
// artifact's createdAt. `short` ("Sep 24, 2026") fits a gallery card's meta
// line; `long` ("September 24, 2026") is the artifact page's header.
export function formatDate(iso: string, style: 'long' | 'short' = 'long'): string {
  return new Date(iso).toLocaleDateString('en-US', {
    day: 'numeric',
    month: style === 'long' ? 'long' : 'short',
    year: 'numeric',
  });
}

// A full UTC timestamp, "2026-09-29 12:00:05 UTC", for times where the hour
// matters, such as when an API key was created or last used.
export function formatTimestamp(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}
