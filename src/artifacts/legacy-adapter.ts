import { renderMarkdownToHtml } from '../markdown.js';
import { resolvePublicBaseUrl } from '../urls.js';
import { extractEmbedReferences } from './embeds.js';
import { legacyTypeFromMediaType, mediaTypeFromLegacyType } from './media.js';
import type {
  Artifact,
  ArtifactService,
  ArtifactStore,
  ArtifactWithContent,
  LegacyArtifact,
} from './types.js';

// Free of Node-only imports (no filesystem, sqlite, or migrations), so the
// app can load under the Workers runtime.

// Copies only the fields of the current model: a caller-supplied store may
// still hand back fields this model has dropped.
function fromLegacyArtifact(artifact: LegacyArtifact): Artifact {
  return {
    createdAt: artifact.createdAt,
    description: artifact.description,
    id: artifact.id,
    mediaType: mediaTypeFromLegacyType(artifact.type),
    project: artifact.project,
    title: artifact.title,
  };
}

// Preserve createApp(store)'s established legacy-store embedding API. Its MCP
// surface remains text-only, as the supplied legacy store is, but both the UI
// and MCP operate on the same caller-owned data.
export function adaptLegacyArtifactStore(store: ArtifactStore): ArtifactService {
  return {
    createArtifact: async (input) => {
      const type = legacyTypeFromMediaType(input.mediaType);
      if (type === undefined) {
        throw new Error('This configured artifact store only supports text media types');
      }
      if (input.collection !== undefined || input.filename !== undefined) {
        throw new Error('This configured artifact store does not support collection or filename');
      }
      return fromLegacyArtifact(
        await store.createArtifact({
          content: new TextDecoder('utf-8', { fatal: true }).decode(input.content),
          description: input.description,
          project: input.project,
          title: input.title,
          type,
        }),
      );
    },
    findArtifact: async (id) => {
      const artifact = (await store.listArtifacts()).find((candidate) => candidate.id === id);
      return artifact === undefined ? null : fromLegacyArtifact(artifact);
    },
    getArtifact: async (id): Promise<ArtifactWithContent | null> => {
      const artifact = await store.getArtifact(id);
      if (artifact === null) {
        return null;
      }
      const { content, ...metadata } = artifact;
      return { ...fromLegacyArtifact(metadata), content: new TextEncoder().encode(content) };
    },
    // A caller-supplied store has nowhere to keep derived data, so an HTML
    // artifact's references, or a Markdown rendering's, are extracted on
    // every view.
    getEmbedReferences: async (id) => {
      const artifact = await store.getArtifact(id);
      if (artifact?.type === 'html') {
        return extractEmbedReferences(artifact.content, resolvePublicBaseUrl());
      }
      return artifact?.type === 'md'
        ? extractEmbedReferences(
            renderMarkdownToHtml(artifact.content).html,
            resolvePublicBaseUrl(),
          )
        : null;
    },
    // A caller-supplied store has nowhere to keep derived data, so its
    // Markdown is rendered on every view.
    getRenderedMarkdown: async (id) => {
      const artifact = await store.getArtifact(id);
      return artifact?.type === 'md' ? renderMarkdownToHtml(artifact.content) : null;
    },
    listArtifacts: async (query) => (await store.listArtifacts(query)).map(fromLegacyArtifact),
    removeArtifact: (id) => store.removeArtifact(id),
  };
}
