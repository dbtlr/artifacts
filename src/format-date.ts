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

// How long until `iso`, rounded down to a coarse unit: "59 min", "23 h",
// "6 d". Never less than "1 min", so a time just reached reads as soon.
export function formatTimeLeft(iso: string, now: Date): string {
  const minutes = Math.floor((new Date(iso).getTime() - now.getTime()) / 60_000);
  if (minutes < 60) {
    return `${String(Math.max(1, minutes))} min`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${String(hours)} h` : `${String(Math.floor(hours / 24))} d`;
}
