export type KeyedLane = {
  // Keys with a running or waiting task.
  activeKeys: () => number;
  // Runs `task` once every earlier task for `key` has settled. Tasks for
  // different keys do not wait for each other.
  run: <T>(key: string, task: () => Promise<T>) => Promise<T>;
};

// An in-process queue per key. A key's entry is dropped when its last task
// settles, so the map holds only keys with work in flight.
export function createKeyedLane(): KeyedLane {
  const tails = new Map<string, Promise<void>>();
  return {
    activeKeys: () => tails.size,
    run: async (key, task) => {
      const previous = tails.get(key);
      const { promise: settled, resolve: release } = Promise.withResolvers<void>();
      tails.set(key, settled);
      await previous;
      try {
        return await task();
      } finally {
        if (tails.get(key) === settled) {
          tails.delete(key);
        }
        release();
      }
    },
  };
}
