import type { Artifact } from '../artifacts/types.js';
import type { ThumbnailRenderer, ThumbnailStore } from './types.js';

export type ThumbnailQueue = {
  // Queue every artifact that has no stored preview yet (boot-time catch-up).
  // Resolves once they are queued, not rendered; rejects if the store
  // cannot say which previews exist.
  backfill: (artifacts: Artifact[]) => Promise<void>;
  // Queue one artifact for (re-)rendering. Never throws and never blocks the
  // caller: a create/update returns as soon as the metadata is written.
  enqueue: (id: string) => void;
  // Resolves once nothing is rendering and nothing is waiting. For tests and
  // graceful shutdown; a queue that has not started resolves immediately.
  idle: () => Promise<void>;
  // Rendering needs the server's own address, which is only known after
  // listen — ids queued before this call wait and are rendered on start.
  start: (renderer: ThumbnailRenderer, baseUrl: string) => void;
};

type ThumbnailQueueDeps = {
  // Fresh metadata at render time: an artifact removed while it was waiting
  // is skipped, and an updated one renders its latest media type.
  lookup: (id: string) => Promise<Artifact | null>;
  report?: (message: string) => void;
  store: ThumbnailStore;
};

function defaultReport(message: string): void {
  process.stderr.write(`${message}\n`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// One render at a time, in enqueue order, so a burst of uploads never opens a
// pile of browser pages at once. Ids are kept in a Set, so an artifact queued
// twice before its turn renders once; queued again after, it renders again.
// Every failure (lookup, renderer, store) is reported and the queue moves on:
// nothing here may reject into the caller or become an unhandled rejection.
export function createThumbnailQueue({
  lookup,
  report = defaultReport,
  store,
}: ThumbnailQueueDeps): ThumbnailQueue {
  const pending = new Set<string>();
  let renderer: ThumbnailRenderer | undefined;
  let baseUrl = '';
  let draining: Promise<void> | undefined;

  async function renderOne(id: string): Promise<void> {
    if (renderer === undefined) {
      return;
    }
    try {
      const artifact = await lookup(id);
      if (artifact === null) {
        return;
      }
      const bytes = await renderer.render({
        id,
        mediaType: artifact.mediaType,
        url: `${baseUrl}/a/${id}`,
      });
      // Removed while rendering: the remove hook already dropped the old
      // file, so writing now would leave an orphan behind.
      if ((await lookup(id)) === null) {
        return;
      }
      if (bytes === null) {
        // Declined (say, an update turned an html artifact into a PDF): a
        // preview of the old content must not outlive it.
        await store.remove(id);
        return;
      }
      await store.write(id, bytes);
      // Removed while writing: a remove can land between the check
      // above and the write. Metadata is always gone before the remove hook
      // drops the file, so checking again after the write catches it.
      if ((await lookup(id)) === null) {
        await store.remove(id);
      }
    } catch (error) {
      report(`Thumbnail render failed for ${id}: ${describe(error)}`);
    }
  }

  // Takes the oldest pending id, renders it, and recurses until the set is
  // empty — sequential on purpose (see above), hence recursion, not a loop
  // of awaits.
  async function drain(): Promise<void> {
    const next = pending.values().next();
    if (next.done) {
      return;
    }
    pending.delete(next.value);
    await renderOne(next.value);
    await drain();
  }

  async function run(): Promise<void> {
    try {
      await drain();
    } catch (error) {
      report(`Thumbnail queue stopped draining: ${describe(error)}`);
    } finally {
      draining = undefined;
      // Anything enqueued while the last render was in flight.
      schedule();
    }
  }

  function schedule(): void {
    if (renderer === undefined || draining !== undefined || pending.size === 0) {
      return;
    }
    draining = run();
  }

  // Adds each artifact without a stored preview to `pending`, checking the
  // store one artifact at a time: this runs once at startup, so a remote
  // store gets a steady trickle of checks rather than all of them at once.
  async function queueMissing(artifacts: Artifact[], index = 0): Promise<void> {
    const artifact = artifacts[index];
    if (artifact === undefined) {
      return;
    }
    if (!(await store.has(artifact.id))) {
      pending.add(artifact.id);
    }
    await queueMissing(artifacts, index + 1);
  }

  async function idle(): Promise<void> {
    const current = draining;
    if (current === undefined) {
      return;
    }
    await current;
    await idle();
  }

  return {
    backfill: async (artifacts) => {
      await queueMissing(artifacts);
      schedule();
    },
    enqueue: (id) => {
      pending.add(id);
      schedule();
    },
    idle,
    start: (nextRenderer, nextBaseUrl) => {
      renderer = nextRenderer;
      baseUrl = nextBaseUrl;
      schedule();
    },
  };
}
