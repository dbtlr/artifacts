import type { LegacyArtifactType as ArtifactType, MediaType } from './media.js';

export type { LegacyArtifactType as ArtifactType, MediaType } from './media.js';

export type Artifact = {
  createdAt: string;
  description: string;
  id: string;
  collection?: string;
  filename?: string;
  mediaType: MediaType;
  project: string;
  title: string;
};

export type ArtifactWithContent = Artifact & { content: Uint8Array };

export type CreateArtifactInput = {
  collection?: string;
  content: Uint8Array;
  description: string;
  filename?: string;
  mediaType: MediaType;
  project: string;
  title: string;
};

export type ListArtifactsQuery = { collection?: string; project?: string };

// Storage ports are async so that adapters over async-only backends fit
// behind them. The sqlite and filesystem adapters still do their I/O
// synchronously and merely resolve with the result. The ports promise no
// atomicity across calls; the service relies only on the order of its calls
// (see artifacts/service.ts), which holds across processes as well.
export type ArtifactMetadataStore = {
  create: (artifact: Artifact) => Promise<void>;
  find: (id: string) => Promise<Artifact | null>;
  list: (query?: ListArtifactsQuery) => Promise<Artifact[]>;
  remove: (id: string) => Promise<boolean>;
};

export type ArtifactContentStore = {
  // Resolves null when no content is stored under the id and media type.
  read: (id: string, mediaType: MediaType) => Promise<Uint8Array | null>;
  remove: (id: string, mediaType: MediaType) => Promise<boolean>;
  write: (id: string, mediaType: MediaType, content: Uint8Array) => Promise<void>;
};

// Artifacts are immutable: once created, an artifact only changes by being
// removed. A variation is a new artifact, usually in the same collection.
export type ArtifactService = {
  createArtifact: (input: CreateArtifactInput) => Promise<Artifact>;
  findArtifact: (id: string) => Promise<Artifact | null>;
  getArtifact: (id: string) => Promise<ArtifactWithContent | null>;
  listArtifacts: (query?: ListArtifactsQuery) => Promise<Artifact[]>;
  removeArtifact: (id: string) => Promise<boolean>;
};

export type LegacyArtifact = Omit<Artifact, 'collection' | 'filename' | 'mediaType'> & {
  type: ArtifactType;
};
export type LegacyArtifactWithContent = LegacyArtifact & { content: string };
export type LegacyCreateArtifactInput = Omit<
  CreateArtifactInput,
  'collection' | 'content' | 'filename' | 'mediaType'
> & {
  content: string;
  type: ArtifactType;
};

// The text-only presentation adapter remains until ART-21 moves MCP to the
// canonical mediaType/byte contract.
export type ArtifactStore = {
  createArtifact: (input: LegacyCreateArtifactInput) => Promise<LegacyArtifact>;
  getArtifact: (id: string) => Promise<LegacyArtifactWithContent | null>;
  listArtifacts: (query?: ListArtifactsQuery) => Promise<LegacyArtifact[]>;
  removeArtifact: (id: string) => Promise<boolean>;
};
