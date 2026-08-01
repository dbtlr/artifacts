import { describe, expect, it } from 'vite-plus/test';

import { createArtifactService } from './service.js';
import type { Artifact, ArtifactContentStore, ArtifactMetadataStore } from './types.js';

const artifact: Artifact = {
  createdAt: '2026-01-01T00:00:00.000Z',
  description: 'description',
  id: 'artifact-id',
  project: 'artifacts',
  title: 'Title',
  type: 'txt',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function createRaceFixture() {
  const writes: Uint8Array[] = [];
  let removed = false;
  const metadata: ArtifactMetadataStore = {
    create: () => undefined,
    find: () => artifact,
    list: () => [artifact],
    remove: () => false,
    update: () => false,
  };
  const content: ArtifactContentStore = {
    move: () => undefined,
    read: () => new TextEncoder().encode('original'),
    remove: () => {
      removed = true;
      return true;
    },
    write: (_id, _type, bytes) => writes.push(bytes),
  };
  return { content, metadata, removed: () => removed, writes };
}

describe('ArtifactService lost metadata races', () => {
  it('rolls content back and returns null when metadata disappears during update', () => {
    const fixture = createRaceFixture();
    const service = createArtifactService(fixture.metadata, fixture.content);

    expect(service.updateArtifact(artifact.id, { content: 'replacement' })).toBeNull();
    expect(fixture.writes.map((bytes) => new TextDecoder().decode(bytes))).toEqual([
      'replacement',
      'original',
    ]);
  });

  it('does not remove content when metadata disappears during removal', () => {
    const fixture = createRaceFixture();
    const service = createArtifactService(fixture.metadata, fixture.content);

    expect(service.removeArtifact(artifact.id)).toBe(false);
    expect(fixture.removed()).toBe(false);
  });
});
