export type ArtifactType = 'html' | 'md' | 'txt';

export type Artifact = {
  createdAt: string;
  description: string;
  id: string;
  project: string;
  title: string;
  type: ArtifactType;
  updatedAt: string;
};

export type ArtifactWithContent = Artifact & { content: string };

export type CreateArtifactInput = {
  content: string;
  description: string;
  project: string;
  title: string;
  type: ArtifactType;
};

export type UpdateArtifactInput = {
  content?: string;
  description?: string;
  project?: string;
  title?: string;
  type?: ArtifactType;
};

export type ListArtifactsQuery = { project?: string };

export type ArtifactMetadataStore = {
  create: (artifact: Artifact) => void;
  find: (id: string) => Artifact | null;
  list: (query?: ListArtifactsQuery) => Artifact[];
  remove: (id: string) => boolean;
  update: (artifact: Artifact) => boolean;
};

export type ArtifactContentStore = {
  move: (id: string, fromType: ArtifactType, toType: ArtifactType) => void;
  read: (id: string, type: ArtifactType) => Uint8Array;
  remove: (id: string, type: ArtifactType) => boolean;
  write: (id: string, type: ArtifactType, content: Uint8Array) => void;
};

export type ArtifactService = {
  createArtifact: (input: CreateArtifactInput) => Artifact;
  getArtifact: (id: string) => ArtifactWithContent | null;
  listArtifacts: (query?: ListArtifactsQuery) => Artifact[];
  removeArtifact: (id: string) => boolean;
  updateArtifact: (id: string, patch: UpdateArtifactInput) => Artifact | null;
};

// Compatibility name for callers while ART-24 moves persistence behind the
// service boundary. New code should use ArtifactService.
export type ArtifactStore = ArtifactService;
