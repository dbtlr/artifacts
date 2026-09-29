import type {
  Artifact,
  ArtifactContentStore,
  ArtifactMetadataStore,
  EmbedTemplate,
  MediaType,
  StoredMarkdownRendering,
} from './types.js';

export type HoldableStep = 'contentRead' | 'contentRemove' | 'metadataCreate';

export type Hold = {
  // Resolves once the held step has been called and is waiting.
  reached: Promise<void>;
  // Lets the held step run.
  release: () => void;
};

export type MemoryStores = {
  content: ArtifactContentStore;
  // Content bytes keyed by `${id}:${mediaType}`.
  files: Map<string, Uint8Array>;
  // Pauses the next call of `step` until the test releases it, so a test can
  // start another operation while the first is partway through.
  hold: (step: HoldableStep) => Hold;
  metadata: ArtifactMetadataStore;
  // Stored Markdown renderings keyed by artifact id.
  renderings: Map<string, StoredMarkdownRendering>;
  rows: Map<string, Artifact>;
  // Stored embed templates keyed by artifact id.
  templates: Map<string, EmbedTemplate>;
};

const fileKey = (id: string, mediaType: MediaType) => `${id}:${mediaType}`;

// Map-backed stores for service tests that need to interleave operations.
export function createMemoryStores(seed: { artifact: Artifact; bytes: Uint8Array }[] = []) {
  const rows = new Map(seed.map(({ artifact }) => [artifact.id, artifact]));
  const files = new Map(
    seed.map(({ artifact, bytes }) => [fileKey(artifact.id, artifact.mediaType), bytes]),
  );
  const renderings = new Map<string, StoredMarkdownRendering>();
  const templates = new Map<string, EmbedTemplate>();
  const holds = new Map<HoldableStep, { gate: Promise<void>; reached: () => void }>();

  async function pass(step: HoldableStep): Promise<void> {
    const held = holds.get(step);
    if (held === undefined) {
      return;
    }
    holds.delete(step);
    held.reached();
    await held.gate;
  }

  const metadata: ArtifactMetadataStore = {
    create: async (artifact) => {
      await pass('metadataCreate');
      if (rows.has(artifact.id)) {
        throw new Error(`Duplicate artifact id ${artifact.id}`);
      }
      rows.set(artifact.id, artifact);
    },
    find: async (id) => rows.get(id) ?? null,
    findEmbedTemplate: async (id) => templates.get(id) ?? null,
    findRendering: async (id) => renderings.get(id) ?? null,
    list: async () => [...rows.values()],
    remove: async (id) => {
      templates.delete(id);
      renderings.delete(id);
      return rows.delete(id);
    },
    saveEmbedTemplate: async (id, template) => {
      if (rows.has(id)) {
        templates.set(id, template);
      }
    },
    saveRendering: async (id, rendering) => {
      if (rows.has(id)) {
        renderings.set(id, rendering);
      }
    },
  };
  const content: ArtifactContentStore = {
    read: async (id, mediaType) => {
      await pass('contentRead');
      return files.get(fileKey(id, mediaType)) ?? null;
    },
    remove: async (id, mediaType) => {
      await pass('contentRemove');
      return files.delete(fileKey(id, mediaType));
    },
    write: async (id, mediaType, bytes) => {
      files.set(fileKey(id, mediaType), bytes);
    },
  };

  return {
    content,
    files,
    hold: (step) => {
      const gate = Promise.withResolvers<void>();
      const reached = Promise.withResolvers<void>();
      holds.set(step, { gate: gate.promise, reached: reached.resolve });
      return { reached: reached.promise, release: gate.resolve };
    },
    metadata,
    renderings,
    rows,
    templates,
  } satisfies MemoryStores;
}
