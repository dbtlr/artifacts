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
  updatedAt: string;
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

export type UpdateArtifactInput = {
  collection?: string | null;
  content?: Uint8Array;
  description?: string;
  filename?: string | null;
  mediaType?: MediaType;
  project?: string;
  title?: string;
};

export type ListArtifactsQuery = { collection?: string; project?: string };

// Storage ports are async so that adapters over async-only backends fit
// behind them. The sqlite and filesystem adapters still do their I/O
// synchronously and merely resolve with the result.
export type ArtifactMetadataStore = {
  create: (artifact: Artifact) => Promise<void>;
  find: (id: string) => Promise<Artifact | null>;
  list: (query?: ListArtifactsQuery) => Promise<Artifact[]>;
  remove: (id: string) => Promise<boolean>;
  update: (artifact: Artifact) => Promise<boolean>;
};

export type ArtifactContentStore = {
  read: (id: string, mediaType: MediaType) => Promise<Uint8Array>;
  remove: (id: string, mediaType: MediaType) => Promise<boolean>;
  write: (id: string, mediaType: MediaType, content: Uint8Array) => Promise<void>;
};

export type ArtifactService = {
  createArtifact: (input: CreateArtifactInput) => Promise<Artifact>;
  findArtifact: (id: string) => Promise<Artifact | null>;
  getArtifact: (id: string) => Promise<ArtifactWithContent | null>;
  listArtifacts: (query?: ListArtifactsQuery) => Promise<Artifact[]>;
  removeArtifact: (id: string) => Promise<boolean>;
  updateArtifact: (id: string, patch: UpdateArtifactInput) => Promise<Artifact | null>;
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
export type LegacyUpdateArtifactInput = Omit<
  UpdateArtifactInput,
  'collection' | 'content' | 'filename' | 'mediaType'
> & {
  content?: string;
  type?: ArtifactType;
};

// The text-only presentation adapter remains until ART-21 moves MCP to the
// canonical mediaType/byte contract.
export type ArtifactStore = {
  createArtifact: (input: LegacyCreateArtifactInput) => Promise<LegacyArtifact>;
  getArtifact: (id: string) => Promise<LegacyArtifactWithContent | null>;
  listArtifacts: (query?: ListArtifactsQuery) => Promise<LegacyArtifact[]>;
  removeArtifact: (id: string) => Promise<boolean>;
  updateArtifact: (id: string, patch: LegacyUpdateArtifactInput) => Promise<LegacyArtifact | null>;
};
