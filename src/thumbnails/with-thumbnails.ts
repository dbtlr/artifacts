import type { ArtifactService } from '../artifacts/types.js';

export type ThumbnailHooks = { enqueue: (id: string) => void; remove: (id: string) => void };

// Decorates the artifact service so previews follow the artifact lifecycle:
// a successful create or update queues a render, a successful remove drops
// the stored preview. Reads pass straight through. Kept outside the service
// itself so the storage rules in artifacts/service.ts stay preview-agnostic.
export function withThumbnails(service: ArtifactService, hooks: ThumbnailHooks): ArtifactService {
  return {
    ...service,
    createArtifact: (input) => {
      const created = service.createArtifact(input);
      hooks.enqueue(created.id);
      return created;
    },
    removeArtifact: (id) => {
      const removed = service.removeArtifact(id);
      if (removed) {
        hooks.remove(id);
      }
      return removed;
    },
    updateArtifact: (id, patch) => {
      const updated = service.updateArtifact(id, patch);
      if (updated !== null) {
        hooks.enqueue(updated.id);
      }
      return updated;
    },
  };
}
