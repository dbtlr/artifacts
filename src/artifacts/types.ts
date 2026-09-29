import type { RenderedMarkdown } from '../markdown.js';
import type { EmbedReference } from './embeds.js';
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

// An HTML artifact's embed template: where its text loads other artifacts of
// this instance, found once when it is stored, so a view can sign those URLs
// without parsing HTML. It is derived data: a template from another
// `extractorVersion` is outdated and is extracted again.
export type EmbedTemplate = { extractorVersion: number; references: EmbedReference[] };

// A Markdown artifact's rendering, stored as derived data so a view never
// parses Markdown. `rendererVersion` names the renderer that produced it; a
// rendering from any other version is outdated and is rendered again.
export type StoredMarkdownRendering = RenderedMarkdown & { rendererVersion: number };

export type ListArtifactsQuery = { collection?: string; project?: string };

// Storage ports are async so that adapters over async-only backends fit
// behind them. The sqlite and filesystem adapters still do their I/O
// synchronously and merely resolve with the result. The ports promise no
// atomicity across calls; the service relies only on the order of its calls
// (see artifacts/service.ts), which holds across processes as well.
export type ArtifactMetadataStore = {
  // Rejects with CreateOutcomeUnknownError (see artifacts/errors.ts) when it
  // cannot tell whether the row was stored, and the service then keeps the
  // new content. Any other rejection means nothing was stored: the service
  // removes the new content, so a row committed despite such a rejection
  // would point at missing content.
  create: (artifact: Artifact) => Promise<void>;
  find: (id: string) => Promise<Artifact | null>;
  // Resolves null when no embed template is stored for the id.
  findEmbedTemplate: (id: string) => Promise<EmbedTemplate | null>;
  // Resolves null when no rendering is stored for the id.
  findRendering: (id: string) => Promise<StoredMarkdownRendering | null>;
  list: (query?: ListArtifactsQuery) => Promise<Artifact[]>;
  // Also drops the artifact's embed template and stored rendering.
  remove: (id: string) => Promise<boolean>;
  // Replaces any stored template. Stores nothing when no artifact has the
  // id, so a save that loses a race with a remove leaves no orphan.
  saveEmbedTemplate: (id: string, template: EmbedTemplate) => Promise<void>;
  // Replaces any stored rendering, under the same rule as saveEmbedTemplate.
  saveRendering: (id: string, rendering: StoredMarkdownRendering) => Promise<void>;
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
  // Where an HTML artifact loads other artifacts of this instance, in text
  // order. Resolves null when no HTML artifact has the id.
  getEmbedReferences: (id: string) => Promise<EmbedReference[] | null>;
  // The rendering of a Markdown artifact, for viewing it without parsing
  // Markdown. Resolves null when no Markdown artifact has the id.
  getRenderedMarkdown: (id: string) => Promise<RenderedMarkdown | null>;
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
