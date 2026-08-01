import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import type { ArtifactStore } from './store.js';
import { createArtifactStore } from './store.js';

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

    const artifact = separateStore.createArtifact({
      content: 'independent storage',
      description: 'Storage isolation proof',
      project: 'artifacts',
      title: 'Separate paths',
      type: 'txt',
    });

    expect(existsSync(databasePath)).toBe(true);
    expect(readFileSync(join(filesDir, `${artifact.id}.txt`), 'utf8')).toBe('independent storage');
  });

  it('writes a content file and a matching row, and returns the artifact', () => {
    const artifact = store.createArtifact({
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

  it('rejects an invalid type and leaves no orphan file behind', () => {
    expect(() =>
      store.createArtifact({
        content: 'x',
        description: 'Bad type',
        project: 'artifacts',
        title: 'Bad',
        // @ts-expect-error deliberately invalid for the test
        type: 'pdf',
      }),
    ).toThrow('Invalid artifact type');

    expect(store.listArtifacts()).toEqual([]);
    expect(readdirSync(join(dir, 'artifacts'))).toEqual([]);
  });

  it.each(['title', 'project', 'description'] as const)(
    'rejects a blank %s and leaves no orphan file behind',
    (field) => {
      expect(() =>
        store.createArtifact({
          content: 'x',
          description: 'd',
          project: 'p',
          title: 't',
          type: 'txt',
          [field]: '   ',
        }),
      ).toThrow(`Invalid artifact ${field}`);

      expect(store.listArtifacts()).toEqual([]);
      expect(readdirSync(join(dir, 'artifacts'))).toEqual([]);
    },
  );

  it('cleans up the content file when the row insert fails', () => {
    const lock = lockDatabaseForWrites(join(dir, 'artifacts.db'));

    try {
      // Reads still succeed under this lock (see lockDatabaseForWrites), so
      // generateId()'s getRow() lookup passes and execution reaches
      // writeFileSync before the INSERT below is the thing that fails.
      expect(store.listArtifacts()).toEqual([]);

      expect(() =>
        store.createArtifact({
          content: 'orphan?',
          description: 'd',
          project: 'p',
          title: 't',
          type: 'txt',
        }),
      ).toThrow('database is locked');
    } finally {
      lock.release();
    }

    expect(readdirSync(join(dir, 'artifacts'))).toEqual([]);
  });
});

describe('getArtifact', () => {
  it('round-trips metadata and content', () => {
    const created = store.createArtifact({
      content: 'hello world',
      description: 'Some notes',
      project: 'demo',
      title: 'Notes',
      type: 'txt',
    });

    const fetched = store.getArtifact(created.id);

    expect(fetched).toEqual({ ...created, content: 'hello world' });
  });

  it('returns null for a missing id', () => {
    expect(store.getArtifact('missing-id')).toBeNull();
  });
});

describe('updateArtifact', () => {
  it('patches metadata fields without touching the content file', () => {
    const created = store.createArtifact({
      content: '# v1',
      description: 'v1',
      project: 'demo',
      title: 'Draft',
      type: 'md',
    });

    const updated = store.updateArtifact(created.id, { description: 'v2', title: 'Final' });

    expect(updated?.title).toBe('Final');
    expect(updated?.description).toBe('v2');
    expect(updated?.project).toBe('demo');
    expect(updated?.createdAt).toBe(created.createdAt);
    expect(new Date(updated?.updatedAt ?? '').getTime()).toBeGreaterThanOrEqual(
      new Date(created.updatedAt).getTime(),
    );
    expect(store.getArtifact(created.id)?.content).toBe('# v1');
  });

  it('replaces content in place when the type is unchanged', () => {
    const created = store.createArtifact({
      content: 'old',
      description: 'v1',
      project: 'demo',
      title: 'Draft',
      type: 'txt',
    });

    store.updateArtifact(created.id, { content: 'new' });

    expect(store.getArtifact(created.id)?.content).toBe('new');
    expect(existsSync(join(dir, 'artifacts', `${created.id}.txt`))).toBe(true);
  });

  it('requires replacement content when the type changes', () => {
    const created = store.createArtifact({
      content: 'plain',
      description: 'v1',
      project: 'demo',
      title: 'Draft',
      type: 'txt',
    });

    expect(() => store.updateArtifact(created.id, { type: 'md' })).toThrow(
      'requires replacement content',
    );

    expect(existsSync(join(dir, 'artifacts', `${created.id}.txt`))).toBe(true);
    expect(existsSync(join(dir, 'artifacts', `${created.id}.md`))).toBe(false);
    expect(store.getArtifact(created.id)?.content).toBe('plain');
  });

  it('writes new content under the new extension when type and content both change', () => {
    const created = store.createArtifact({
      content: 'plain',
      description: 'v1',
      project: 'demo',
      title: 'Draft',
      type: 'txt',
    });

    store.updateArtifact(created.id, { content: '<p>hi</p>', type: 'html' });

    expect(existsSync(join(dir, 'artifacts', `${created.id}.txt`))).toBe(false);
    expect(store.getArtifact(created.id)?.content).toBe('<p>hi</p>');
  });

  it('returns null for a missing id', () => {
    expect(store.updateArtifact('missing-id', { title: 'x' })).toBeNull();
  });

  it('rejects an invalid type', () => {
    const created = store.createArtifact({
      content: 'plain',
      description: 'v1',
      project: 'demo',
      title: 'Draft',
      type: 'txt',
    });

    // @ts-expect-error deliberately invalid for the test
    expect(() => store.updateArtifact(created.id, { type: 'exe' })).toThrow(
      'Invalid artifact type',
    );
  });

  it.each(['title', 'project', 'description'] as const)('rejects a blank %s patch', (field) => {
    const created = store.createArtifact({
      content: 'plain',
      description: 'v1',
      project: 'demo',
      title: 'Draft',
      type: 'txt',
    });

    expect(() => store.updateArtifact(created.id, { [field]: '   ' })).toThrow(
      `Invalid artifact ${field}`,
    );
    expect(store.getArtifact(created.id)?.[field]).toBe(created[field]);
  });

  it('restores the original content file when the row update fails', () => {
    const created = store.createArtifact({
      content: 'original',
      description: 'v1',
      project: 'demo',
      title: 'Draft',
      type: 'txt',
    });
    const lock = lockDatabaseForWrites(join(dir, 'artifacts.db'));

    try {
      // Proves the read (getRow) inside updateArtifact isn't what's failing.
      expect(store.getArtifact(created.id)?.content).toBe('original');

      expect(() => store.updateArtifact(created.id, { content: 'new' })).toThrow(
        'database is locked',
      );
    } finally {
      lock.release();
    }

    expect(store.getArtifact(created.id)?.content).toBe('original');
    expect(readdirSync(join(dir, 'artifacts'))).toEqual([`${created.id}.txt`]);
  });

  it('restores the original file path when a type-changing update fails', () => {
    const created = store.createArtifact({
      content: 'plain',
      description: 'v1',
      project: 'demo',
      title: 'Draft',
      type: 'txt',
    });
    const lock = lockDatabaseForWrites(join(dir, 'artifacts.db'));

    try {
      expect(store.getArtifact(created.id)?.content).toBe('plain');

      expect(() => store.updateArtifact(created.id, { content: '# plain', type: 'md' })).toThrow(
        'database is locked',
      );
    } finally {
      lock.release();
    }

    expect(store.getArtifact(created.id)?.type).toBe('txt');
    expect(store.getArtifact(created.id)?.content).toBe('plain');
    expect(readdirSync(join(dir, 'artifacts'))).toEqual([`${created.id}.txt`]);
  });

  it('restores both the original path and content when a content+type update fails', () => {
    const created = store.createArtifact({
      content: 'plain',
      description: 'v1',
      project: 'demo',
      title: 'Draft',
      type: 'txt',
    });
    const lock = lockDatabaseForWrites(join(dir, 'artifacts.db'));

    try {
      expect(store.getArtifact(created.id)?.content).toBe('plain');

      expect(() =>
        store.updateArtifact(created.id, { content: '<p>hi</p>', type: 'html' }),
      ).toThrow('database is locked');
    } finally {
      lock.release();
    }

    expect(store.getArtifact(created.id)?.type).toBe('txt');
    expect(store.getArtifact(created.id)?.content).toBe('plain');
    expect(readdirSync(join(dir, 'artifacts'))).toEqual([`${created.id}.txt`]);
  });
});

describe('removeArtifact', () => {
  it('deletes the row and the content file, and is false on a repeat call', () => {
    const created = store.createArtifact({
      content: 'bye',
      description: 'gone soon',
      project: 'demo',
      title: 'Temp',
      type: 'txt',
    });
    const filePath = join(dir, 'artifacts', `${created.id}.txt`);

    expect(store.removeArtifact(created.id)).toBe(true);
    expect(existsSync(filePath)).toBe(false);
    expect(store.getArtifact(created.id)).toBeNull();
    expect(store.removeArtifact(created.id)).toBe(false);
  });

  it('returns false for an id that never existed', () => {
    expect(store.removeArtifact('never-existed')).toBe(false);
  });
});

describe('listArtifacts', () => {
  it('lists newest first and filters by project', () => {
    const a = store.createArtifact({
      content: 'a',
      description: 'first',
      project: 'proj-one',
      title: 'A',
      type: 'txt',
    });
    const b = store.createArtifact({
      content: 'b',
      description: 'second',
      project: 'proj-two',
      title: 'B',
      type: 'txt',
    });
    const c = store.createArtifact({
      content: 'c',
      description: 'third',
      project: 'proj-one',
      title: 'C',
      type: 'txt',
    });

    const all = store.listArtifacts();
    expect(all.map((artifact) => artifact.id)).toEqual([c.id, b.id, a.id]);

    const filtered = store.listArtifacts({ project: 'proj-one' });
    expect(filtered.map((artifact) => artifact.id)).toEqual([c.id, a.id]);

    filtered.forEach((artifact) => {
      expect(artifact).not.toHaveProperty('content');
    });
  });

  it('returns an empty list when nothing has been created', () => {
    expect(store.listArtifacts()).toEqual([]);
  });

  it('breaks a created_at tie by insertion order, newest first', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const first = store.createArtifact({
        content: 'a',
        description: 'first',
        project: 'demo',
        title: 'First',
        type: 'txt',
      });
      const second = store.createArtifact({
        content: 'b',
        description: 'second',
        project: 'demo',
        title: 'Second',
        type: 'txt',
      });

      expect(first.createdAt).toBe(second.createdAt);
      expect(store.listArtifacts().map((artifact) => artifact.id)).toEqual([second.id, first.id]);
    } finally {
      vi.useRealTimers();
    }
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
