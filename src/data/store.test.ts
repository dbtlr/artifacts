import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import type { ArtifactStore } from './store.js';
import {
  adaptLegacyArtifactStore,
  createArtifactStore,
  createByteNativeArtifactService,
  legacyArtifactStoreFromService,
} from './store.js';

let dir: string;
let store: ArtifactStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'artifacts-store-'));
  store = await createArtifactStore({
    databasePath: join(dir, 'artifacts.db'),
    filesDir: join(dir, 'artifacts'),
  });
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe('adaptLegacyArtifactStore', () => {
  it('finds metadata without reading artifact content', async () => {
    const artifact = {
      createdAt: '2026-01-01T00:00:00.000Z',
      description: 'metadata only',
      id: 'metadata-id',
      project: 'artifacts',
      title: 'Metadata',
      type: 'txt' as const,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const getArtifact = vi.fn(() => {
      throw new Error('content must not be read');
    });
    const legacyStore: ArtifactStore = {
      createArtifact: vi.fn(),
      getArtifact,
      listArtifacts: vi.fn(async () => [artifact]),
      removeArtifact: vi.fn(),
      updateArtifact: vi.fn(),
    };

    await expect(adaptLegacyArtifactStore(legacyStore).findArtifact(artifact.id)).resolves.toEqual({
      createdAt: artifact.createdAt,
      description: artifact.description,
      id: artifact.id,
      mediaType: 'text/plain',
      project: artifact.project,
      title: artifact.title,
      updatedAt: artifact.updatedAt,
    });
    expect(getArtifact).not.toHaveBeenCalled();
  });
});

// A second connection to the same db file, switched to WAL and holding an
// IMMEDIATE (write) lock, makes any *write* from the store's own connection
// fail deterministically with "database is locked" — while leaving reads
// (SELECT) unaffected. That distinction matters: a plain `BEGIN EXCLUSIVE`
// also blocks the store's own reads, so createArtifact/updateArtifact would
// fail at their first getRow() lookup, before ever touching a file — making
// any rollback/cleanup assertion vacuously true. WAL + BEGIN IMMEDIATE forces
// the failure specifically at the INSERT/UPDATE statement, which only runs
// after the file has already been written/renamed, so these tests genuinely
// exercise the cleanup/rollback code.
function lockDatabaseForWrites(dbPath: string): { release: () => void } {
  const lock = new DatabaseSync(dbPath);
  lock.exec('PRAGMA journal_mode = WAL');
  lock.exec('BEGIN IMMEDIATE');
  return {
    release: () => {
      lock.exec('COMMIT');
      lock.close();
    },
  };
}

describe('createArtifact', () => {
  it('stores content and SQLite metadata at independent configured paths', async () => {
    const databasePath = join(dir, 'database', 'metadata.sqlite');
    const filesDir = join(dir, 'files');
    const separateStore = await createArtifactStore({ databasePath, filesDir });

    const artifact = await separateStore.createArtifact({
      content: 'independent storage',
      description: 'Storage isolation proof',
      project: 'artifacts',
      title: 'Separate paths',
      type: 'txt',
    });

    expect(existsSync(databasePath)).toBe(true);
    expect(readFileSync(join(filesDir, `${artifact.id}.txt`), 'utf8')).toBe('independent storage');
  });

  it('writes a content file and a matching row, and returns the artifact', async () => {
    const artifact = await store.createArtifact({
      content: '# Plan\n',
      description: 'A phased plan',
      project: 'artifacts',
      title: 'Plan',
      type: 'md',
    });

    expect(artifact.id).toHaveLength(10);
    expect(artifact.title).toBe('Plan');
    expect(artifact.createdAt).toBe(artifact.updatedAt);

    const filePath = join(dir, 'artifacts', `${artifact.id}.md`);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('# Plan\n');
  });

  it('rejects an invalid type and leaves no orphan file behind', async () => {
    await expect(
      store.createArtifact({
        content: 'x',
        description: 'Bad type',
        project: 'artifacts',
        title: 'Bad',
        // @ts-expect-error deliberately invalid for the test
        type: 'pdf',
      }),
    ).rejects.toThrow('Invalid artifact type');

    await expect(store.listArtifacts()).resolves.toEqual([]);
    expect(readdirSync(join(dir, 'artifacts'))).toEqual([]);
  });

  it.each(['title', 'project', 'description'] as const)(
    'rejects a blank %s and leaves no orphan file behind',
    async (field) => {
      await expect(
        store.createArtifact({
          content: 'x',
          description: 'd',
          project: 'p',
          title: 't',
          type: 'txt',
          [field]: '   ',
        }),
      ).rejects.toThrow(`Invalid artifact ${field}`);

      await expect(store.listArtifacts()).resolves.toEqual([]);
      expect(readdirSync(join(dir, 'artifacts'))).toEqual([]);
    },
  );

  it('cleans up the content file when the row insert fails', async () => {
    const lock = lockDatabaseForWrites(join(dir, 'artifacts.db'));

    try {
      // Reads still succeed under this lock (see lockDatabaseForWrites), so
      // generateId()'s getRow() lookup passes and execution reaches
      // writeFileSync before the INSERT below is the thing that fails.
      await expect(store.listArtifacts()).resolves.toEqual([]);

      await expect(
        store.createArtifact({
          content: 'orphan?',
          description: 'd',
          project: 'p',
          title: 't',
          type: 'txt',
        }),
      ).rejects.toThrow('database is locked');
    } finally {
      lock.release();
    }

    expect(readdirSync(join(dir, 'artifacts'))).toEqual([]);
  });
});

describe('getArtifact', () => {
  it('round-trips metadata and content', async () => {
    const created = await store.createArtifact({
      content: 'hello world',
      description: 'Some notes',
      project: 'demo',
      title: 'Notes',
      type: 'txt',
    });

    const fetched = await store.getArtifact(created.id);

    expect(fetched).toEqual({ ...created, content: 'hello world' });
  });

  it('returns null for a missing id', async () => {
    await expect(store.getArtifact('missing-id')).resolves.toBeNull();
  });
});

describe('updateArtifact', () => {
  it('patches metadata fields without touching the content file', async () => {
    const created = await store.createArtifact({
      content: '# v1',
      description: 'v1',
      project: 'demo',
      title: 'Draft',
      type: 'md',
    });

    const updated = await store.updateArtifact(created.id, { description: 'v2', title: 'Final' });

    expect(updated?.title).toBe('Final');
    expect(updated?.description).toBe('v2');
    expect(updated?.project).toBe('demo');
    expect(updated?.createdAt).toBe(created.createdAt);
    expect(new Date(updated?.updatedAt ?? '').getTime()).toBeGreaterThanOrEqual(
      new Date(created.updatedAt).getTime(),
    );
    expect((await store.getArtifact(created.id))?.content).toBe('# v1');
  });

  it('replaces content in place when the type is unchanged', async () => {
    const created = await store.createArtifact({
      content: 'old',
      description: 'v1',
      project: 'demo',
      title: 'Draft',
      type: 'txt',
    });

    await store.updateArtifact(created.id, { content: 'new' });

    expect((await store.getArtifact(created.id))?.content).toBe('new');
    expect(existsSync(join(dir, 'artifacts', `${created.id}.txt`))).toBe(true);
  });

  it('requires replacement content when the type changes', async () => {
    const created = await store.createArtifact({
      content: 'plain',
      description: 'v1',
      project: 'demo',
      title: 'Draft',
      type: 'txt',
    });

    await expect(store.updateArtifact(created.id, { type: 'md' })).rejects.toThrow(
      'requires replacement content',
    );

    expect(existsSync(join(dir, 'artifacts', `${created.id}.txt`))).toBe(true);
    expect(existsSync(join(dir, 'artifacts', `${created.id}.md`))).toBe(false);
    expect((await store.getArtifact(created.id))?.content).toBe('plain');
  });

  it('writes new content under the new extension when type and content both change', async () => {
    const created = await store.createArtifact({
      content: 'plain',
      description: 'v1',
      project: 'demo',
      title: 'Draft',
      type: 'txt',
    });

    await store.updateArtifact(created.id, { content: '<p>hi</p>', type: 'html' });

    expect(existsSync(join(dir, 'artifacts', `${created.id}.txt`))).toBe(false);
    expect((await store.getArtifact(created.id))?.content).toBe('<p>hi</p>');
  });

  it('returns null for a missing id', async () => {
    await expect(store.updateArtifact('missing-id', { title: 'x' })).resolves.toBeNull();
  });

  it('rejects an invalid type', async () => {
    const created = await store.createArtifact({
      content: 'plain',
      description: 'v1',
      project: 'demo',
      title: 'Draft',
      type: 'txt',
    });

    // @ts-expect-error deliberately invalid for the test
    await expect(store.updateArtifact(created.id, { type: 'exe' })).rejects.toThrow(
      'Invalid artifact type',
    );
  });

  it.each(['title', 'project', 'description'] as const)(
    'rejects a blank %s patch',
    async (field) => {
      const created = await store.createArtifact({
        content: 'plain',
        description: 'v1',
        project: 'demo',
        title: 'Draft',
        type: 'txt',
      });

      await expect(store.updateArtifact(created.id, { [field]: '   ' })).rejects.toThrow(
        `Invalid artifact ${field}`,
      );
      expect((await store.getArtifact(created.id))?.[field]).toBe(created[field]);
    },
  );

  it('restores the original content file when the row update fails', async () => {
    const created = await store.createArtifact({
      content: 'original',
      description: 'v1',
      project: 'demo',
      title: 'Draft',
      type: 'txt',
    });
    const lock = lockDatabaseForWrites(join(dir, 'artifacts.db'));

    try {
      // Proves the read (getRow) inside updateArtifact isn't what's failing.
      expect((await store.getArtifact(created.id))?.content).toBe('original');

      await expect(store.updateArtifact(created.id, { content: 'new' })).rejects.toThrow(
        'database is locked',
      );
    } finally {
      lock.release();
    }

    expect((await store.getArtifact(created.id))?.content).toBe('original');
    expect(readdirSync(join(dir, 'artifacts'))).toEqual([`${created.id}.txt`]);
  });

  it('restores the original file path when a type-changing update fails', async () => {
    const created = await store.createArtifact({
      content: 'plain',
      description: 'v1',
      project: 'demo',
      title: 'Draft',
      type: 'txt',
    });
    const lock = lockDatabaseForWrites(join(dir, 'artifacts.db'));

    try {
      expect((await store.getArtifact(created.id))?.content).toBe('plain');

      await expect(
        store.updateArtifact(created.id, { content: '# plain', type: 'md' }),
      ).rejects.toThrow('database is locked');
    } finally {
      lock.release();
    }

    expect((await store.getArtifact(created.id))?.type).toBe('txt');
    expect((await store.getArtifact(created.id))?.content).toBe('plain');
    expect(readdirSync(join(dir, 'artifacts'))).toEqual([`${created.id}.txt`]);
  });

  it('restores both the original path and content when a content+type update fails', async () => {
    const created = await store.createArtifact({
      content: 'plain',
      description: 'v1',
      project: 'demo',
      title: 'Draft',
      type: 'txt',
    });
    const lock = lockDatabaseForWrites(join(dir, 'artifacts.db'));

    try {
      expect((await store.getArtifact(created.id))?.content).toBe('plain');

      await expect(
        store.updateArtifact(created.id, { content: '<p>hi</p>', type: 'html' }),
      ).rejects.toThrow('database is locked');
    } finally {
      lock.release();
    }

    expect((await store.getArtifact(created.id))?.type).toBe('txt');
    expect((await store.getArtifact(created.id))?.content).toBe('plain');
    expect(readdirSync(join(dir, 'artifacts'))).toEqual([`${created.id}.txt`]);
  });
});

describe('removeArtifact', () => {
  it('deletes the row and the content file, and is false on a repeat call', async () => {
    const created = await store.createArtifact({
      content: 'bye',
      description: 'gone soon',
      project: 'demo',
      title: 'Temp',
      type: 'txt',
    });
    const filePath = join(dir, 'artifacts', `${created.id}.txt`);

    await expect(store.removeArtifact(created.id)).resolves.toBe(true);
    expect(existsSync(filePath)).toBe(false);
    await expect(store.getArtifact(created.id)).resolves.toBeNull();
    await expect(store.removeArtifact(created.id)).resolves.toBe(false);
  });

  it('returns false for an id that never existed', async () => {
    await expect(store.removeArtifact('never-existed')).resolves.toBe(false);
  });
});

describe('listArtifacts', () => {
  it('lists newest first and filters by project', async () => {
    const a = await store.createArtifact({
      content: 'a',
      description: 'first',
      project: 'proj-one',
      title: 'A',
      type: 'txt',
    });
    const b = await store.createArtifact({
      content: 'b',
      description: 'second',
      project: 'proj-two',
      title: 'B',
      type: 'txt',
    });
    const c = await store.createArtifact({
      content: 'c',
      description: 'third',
      project: 'proj-one',
      title: 'C',
      type: 'txt',
    });

    const all = await store.listArtifacts();
    expect(all.map((artifact) => artifact.id)).toEqual([c.id, b.id, a.id]);

    const filtered = await store.listArtifacts({ project: 'proj-one' });
    expect(filtered.map((artifact) => artifact.id)).toEqual([c.id, a.id]);

    filtered.forEach((artifact) => {
      expect(artifact).not.toHaveProperty('content');
    });
  });

  it('returns an empty list when nothing has been created', async () => {
    await expect(store.listArtifacts()).resolves.toEqual([]);
  });

  it('preserves legacy text reads when binary rows coexist', async () => {
    const text = await store.createArtifact({
      content: 'text',
      description: 'legacy text',
      project: 'mixed',
      title: 'Text',
      type: 'txt',
    });
    const byteNative = await createByteNativeArtifactService({
      databasePath: join(dir, 'artifacts.db'),
      filesDir: join(dir, 'artifacts'),
    });
    const binary = await byteNative.createArtifact({
      content: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      description: 'binary',
      filename: 'preview.png',
      mediaType: 'image/png',
      project: 'mixed',
      title: 'Binary',
    });

    expect((await store.listArtifacts({ project: 'mixed' })).map(({ id }) => id)).toEqual([
      text.id,
    ]);
    expect((await store.getArtifact(text.id))?.content).toBe('text');
    await expect(store.getArtifact(binary.id)).resolves.toBeNull();
    await expect(store.updateArtifact(binary.id, { title: 'Hidden mutation' })).resolves.toBeNull();
    await expect(store.removeArtifact(binary.id)).resolves.toBe(false);
    expect((await byteNative.getArtifact(binary.id))?.title).toBe('Binary');
  });

  it('updates metadata and removes a text row when its content file is missing', async () => {
    const artifact = await store.createArtifact({
      content: 'missing later',
      description: 'repairable metadata',
      project: 'repairs',
      title: 'Before',
      type: 'txt',
    });
    rmSync(join(dir, 'artifacts', `${artifact.id}.txt`));

    expect((await store.updateArtifact(artifact.id, { title: 'After' }))?.title).toBe('After');
    await expect(store.removeArtifact(artifact.id)).resolves.toBe(true);
    await expect(store.listArtifacts()).resolves.toEqual([]);
  });

  it('breaks a created_at tie by insertion order, newest first', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const first = await store.createArtifact({
        content: 'a',
        description: 'first',
        project: 'demo',
        title: 'First',
        type: 'txt',
      });
      const second = await store.createArtifact({
        content: 'b',
        description: 'second',
        project: 'demo',
        title: 'Second',
        type: 'txt',
      });

      expect(first.createdAt).toBe(second.createdAt);
      expect((await store.listArtifacts()).map((artifact) => artifact.id)).toEqual([
        second.id,
        first.id,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('legacy store over a shared service', () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const toPng = { content: png, filename: 'x.png', mediaType: 'image/png' } as const;

  async function markdownArtifact() {
    const service = await createByteNativeArtifactService({
      databasePath: join(dir, 'shared.db'),
      filesDir: join(dir, 'shared'),
    });
    const created = await service.createArtifact({
      content: new TextEncoder().encode('# md'),
      description: 'd',
      mediaType: 'text/markdown',
      project: 'p',
      title: 'Markdown',
    });
    return { created, legacy: legacyArtifactStoreFromService(service), service };
  }

  it('does not remove an artifact that a concurrent update made binary', async () => {
    const { created, legacy, service } = await markdownArtifact();

    const [, removed] = await Promise.all([
      service.updateArtifact(created.id, toPng),
      legacy.removeArtifact(created.id),
    ]);

    expect(removed).toBe(false);
    expect((await service.findArtifact(created.id))?.mediaType).toBe('image/png');
  });

  it('does not update an artifact that a concurrent update made binary', async () => {
    const { created, legacy, service } = await markdownArtifact();

    const [, updated] = await Promise.all([
      service.updateArtifact(created.id, toPng),
      legacy.updateArtifact(created.id, { title: 'Hidden mutation' }),
    ]);

    expect(updated).toBeNull();
    expect((await service.findArtifact(created.id))?.title).toBe('Markdown');
  });
});

const appendOne = (current: { title: string }) => ({ title: `${current.title}1` });

describe('service adapted from a legacy store', () => {
  it('decides each concurrent update against the result of the one before it', async () => {
    const created = await store.createArtifact({
      content: '# md',
      description: 'd',
      project: 'p',
      title: 'T',
      type: 'md',
    });
    const service = adaptLegacyArtifactStore(store);

    await Promise.all([
      service.updateArtifact(created.id, appendOne),
      service.updateArtifact(created.id, appendOne),
    ]);

    expect((await service.findArtifact(created.id))?.title).toBe('T11');
  });

  it('checks a remove precondition against the result of an earlier update', async () => {
    const created = await store.createArtifact({
      content: '# md',
      description: 'd',
      project: 'p',
      title: 'Keep',
      type: 'md',
    });
    const service = adaptLegacyArtifactStore(store);

    const [, removed] = await Promise.all([
      service.updateArtifact(created.id, { title: 'Remove me' }),
      service.removeArtifact(created.id, (current) => current.title === 'Keep'),
    ]);

    expect(removed).toBe(false);
    expect((await service.findArtifact(created.id))?.title).toBe('Remove me');
  });
});

describe('getDefaultArtifactStore', () => {
  const originalDatabasePath = process.env.ARTIFACTS_DATABASE_PATH;
  const originalFilesDir = process.env.ARTIFACTS_FILES_DIR;
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'artifacts-default-'));
    process.env.ARTIFACTS_DATABASE_PATH = join(base, 'database', 'artifacts.db');
    process.env.ARTIFACTS_FILES_DIR = join(base, 'files');
  });

  afterEach(() => {
    if (originalDatabasePath === undefined) {
      delete process.env.ARTIFACTS_DATABASE_PATH;
    } else {
      process.env.ARTIFACTS_DATABASE_PATH = originalDatabasePath;
    }
    if (originalFilesDir === undefined) {
      delete process.env.ARTIFACTS_FILES_DIR;
    } else {
      process.env.ARTIFACTS_FILES_DIR = originalFilesDir;
    }
    rmSync(base, { force: true, recursive: true });
    vi.resetModules();
  });

  it('creates nothing on import, and lazily creates + memoizes the default store on first use', async () => {
    vi.resetModules();
    const freshStore = await import('./store.js');
    const databasePath = join(base, 'database', 'artifacts.db');
    const filesDir = join(base, 'files');

    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(filesDir)).toBe(false);

    const first = await freshStore.getDefaultArtifactStore();
    expect(existsSync(databasePath)).toBe(true);
    expect(existsSync(filesDir)).toBe(true);

    const second = await freshStore.getDefaultArtifactStore();
    expect(second).toBe(first);
  });

  it('derives the default legacy store from the canonical default service', async () => {
    vi.resetModules();
    const freshStore = await import('./store.js');
    const service = await freshStore.getDefaultByteNativeArtifactService();
    const legacy = await freshStore.getDefaultArtifactStore();

    const artifact = await service.createArtifact({
      content: new TextEncoder().encode('shared service'),
      description: 'shared composition root',
      mediaType: 'text/plain',
      project: 'artifacts',
      title: 'Shared',
    });

    expect((await legacy.getArtifact(artifact.id))?.content).toBe('shared service');
  });

  it('retries after a transient initialization failure', async () => {
    vi.resetModules();
    const freshStore = await import('./store.js');
    const databasePath = join(base, 'database', 'artifacts.db');
    mkdirSync(databasePath, { recursive: true });

    await expect(freshStore.getDefaultArtifactStore()).rejects.toBeInstanceOf(Error);
    rmSync(databasePath, { force: true, recursive: true });

    await expect(freshStore.getDefaultArtifactStore()).resolves.toBeDefined();
    expect(existsSync(databasePath)).toBe(true);
  });
});
