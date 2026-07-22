// Fixed locale/options keep server-rendered dates deterministic regardless of
// the host's configured locale — shared by every component that displays an
// artifact's createdAt.
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
