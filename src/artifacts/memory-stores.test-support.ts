import type { Artifact, ArtifactContentStore, ArtifactMetadataStore, MediaType } from './types.js';

export type HoldableStep = 'contentWrite' | 'metadataUpdate';

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
  rows: Map<string, Artifact>;
};

const fileKey = (id: string, mediaType: MediaType) => `${id}:${mediaType}`;

// Map-backed stores for service tests that need to interleave operations.
export function createMemoryStores(seed: { artifact: Artifact; bytes: Uint8Array }[] = []) {
  const rows = new Map(seed.map(({ artifact }) => [artifact.id, artifact]));
  const files = new Map(
    seed.map(({ artifact, bytes }) => [fileKey(artifact.id, artifact.mediaType), bytes]),
  );
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
      rows.set(artifact.id, artifact);
    },
    find: async (id) => rows.get(id) ?? null,
    list: async () => [...rows.values()],
    remove: async (id) => rows.delete(id),
    update: async (artifact) => {
      await pass('metadataUpdate');
      if (!rows.has(artifact.id)) {
        return false;
      }
      rows.set(artifact.id, artifact);
      return true;
    },
  };
  const content: ArtifactContentStore = {
    read: async (id, mediaType) => {
      const bytes = files.get(fileKey(id, mediaType));
      if (bytes === undefined) {
        throw new Error(`ENOENT ${fileKey(id, mediaType)}`);
      }
      return bytes;
    },
    remove: async (id, mediaType) => files.delete(fileKey(id, mediaType)),
    write: async (id, mediaType, bytes) => {
      await pass('contentWrite');
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
    rows,
  } satisfies MemoryStores;
}
