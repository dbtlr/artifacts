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

export type ArtifactMetadataStore = {
  create: (artifact: Artifact) => void;
  find: (id: string) => Artifact | null;
  list: (query?: ListArtifactsQuery) => Artifact[];
  remove: (id: string) => boolean;
  update: (artifact: Artifact) => boolean;
};

export type ArtifactContentStore = {
  read: (id: string, mediaType: MediaType) => Uint8Array;
  remove: (id: string, mediaType: MediaType) => boolean;
  write: (id: string, mediaType: MediaType, content: Uint8Array) => void;
};

export type ArtifactService = {
  createArtifact: (input: CreateArtifactInput) => Artifact;
  getArtifact: (id: string) => ArtifactWithContent | null;
  listArtifacts: (query?: ListArtifactsQuery) => Artifact[];
  removeArtifact: (id: string) => boolean;
  updateArtifact: (id: string, patch: UpdateArtifactInput) => Artifact | null;
};

export type LegacyArtifact = Omit<Artifact, 'mediaType'> & { type: ArtifactType };
export type LegacyArtifactWithContent = LegacyArtifact & { content: string };
export type LegacyCreateArtifactInput = Omit<CreateArtifactInput, 'content' | 'mediaType'> & {
  content: string;
  type: ArtifactType;
};
export type LegacyUpdateArtifactInput = Omit<UpdateArtifactInput, 'content' | 'mediaType'> & {
  content?: string;
  type?: ArtifactType;
};

// The text-only presentation adapter remains until ART-21 moves MCP to the
// canonical mediaType/byte contract.
export type ArtifactStore = {
  createArtifact: (input: LegacyCreateArtifactInput) => LegacyArtifact;
  getArtifact: (id: string) => LegacyArtifactWithContent | null;
  listArtifacts: (query?: ListArtifactsQuery) => LegacyArtifact[];
  removeArtifact: (id: string) => boolean;
  updateArtifact: (id: string, patch: LegacyUpdateArtifactInput) => LegacyArtifact | null;
};
