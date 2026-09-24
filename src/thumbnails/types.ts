import type { MediaType } from '../artifacts/media.js';

// What a renderer needs to produce one preview: the artifact's own URL on
// this server, so html is rendered exactly as a visitor sees it, md/txt come
// through the app's own page, and images load with their real headers.
export type ThumbnailTarget = { id: string; mediaType: MediaType; url: string };

export type ThumbnailRenderer = {
  close: () => Promise<void>;
  // Resolves to encoded JPEG bytes, or null when this kind cannot be
  // rendered (the gallery then keeps its drawn placeholder).
  render: (target: ThumbnailTarget) => Promise<Uint8Array | null>;
};

export type ThumbnailStore = {
  has: (id: string) => boolean;
  read: (id: string) => Uint8Array | null;
  remove: (id: string) => void;
  write: (id: string, bytes: Uint8Array) => void;
};
