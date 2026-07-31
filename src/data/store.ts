import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SQLOutputValue } from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';

import { nanoid } from 'nanoid';

import { resolveStoragePaths } from '../data-dir.js';
import type { StoragePaths } from '../data-dir.js';

export type ArtifactType = 'html' | 'md' | 'txt';

const ARTIFACT_TYPES: readonly ArtifactType[] = ['html', 'md', 'txt'];

export type Artifact = {
  createdAt: string;
  description: string;
  id: string;
  project: string;
  title: string;
  type: ArtifactType;
  updatedAt: string;
};

export type ArtifactWithContent = Artifact & { content: string };

export type CreateArtifactInput = {
  content: string;
  description: string;
  project: string;
  title: string;
  type: ArtifactType;
};

export type UpdateArtifactInput = {
  content?: string;
  description?: string;
  project?: string;
  title?: string;
  type?: ArtifactType;
};

export type ListArtifactsQuery = { project?: string };

export type ArtifactStore = {
  createArtifact: (input: CreateArtifactInput) => Artifact;
  getArtifact: (id: string) => ArtifactWithContent | null;
  listArtifacts: (query?: ListArtifactsQuery) => Artifact[];
  removeArtifact: (id: string) => boolean;
  updateArtifact: (id: string, patch: UpdateArtifactInput) => Artifact | null;
};

// The row shape used internally — snake_case columns, matching the schema.
type ArtifactRow = {
  created_at: string;
  description: string;
  id: string;
  project: string;
  title: string;
  type: ArtifactType;
  updated_at: string;
};

const ID_LENGTH = 10;
const MAX_ID_ATTEMPTS = 5;

function isoNow(): string {
  return new Date().toISOString();
}

function isArtifactType(value: string): value is ArtifactType {
  return value === 'html' || value === 'md' || value === 'txt';
}

function assertValidType(type: ArtifactType): void {
  if (!isArtifactType(type)) {
    throw new Error(
      `Invalid artifact type ${JSON.stringify(type)}, expected one of ${ARTIFACT_TYPES.join(', ')}`,
    );
  }
}

type BlankableField = 'description' | 'project' | 'title';

// title/project/description all drive list-view identification (CLAUDE.md),
// so a blank one is never useful — reject it up front, before any write.
function assertNonBlank(field: BlankableField, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Invalid artifact ${field} ${JSON.stringify(value)}: must not be blank`);
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

// node:sqlite hands rows back as untyped `Record<string, SQLOutputValue>`;
// coerce field by field instead of casting so a corrupt row throws here
// rather than propagating a lie about its shape.
function toArtifactRow(record: Record<string, SQLOutputValue>): ArtifactRow {
  const type = String(record.type);
  if (!isArtifactType(type)) {
    throw new Error(`Corrupt artifacts row: unexpected type ${JSON.stringify(type)}`);
  }
  return {
    created_at: String(record.created_at),
    description: String(record.description),
    id: String(record.id),
    project: String(record.project),
    title: String(record.title),
    type,
    updated_at: String(record.updated_at),
  };
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    createdAt: row.created_at,
    description: row.description,
    id: row.id,
    project: row.project,
    title: row.title,
    type: row.type,
    updatedAt: row.updated_at,
  };
}

// Creates the independently configured SQLite database and content directory
// if missing, then returns a store bound to both. Schema creation is idempotent.
export function createArtifactStore({ databasePath, filesDir }: StoragePaths): ArtifactStore {
  mkdirSync(filesDir, { recursive: true });
  mkdirSync(dirname(databasePath), { recursive: true });

  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project TEXT NOT NULL,
      description TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('html','md','txt')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project);
    CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at);
  `);

  const insertStatement = db.prepare(
    'INSERT INTO artifacts (id, title, project, description, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const selectStatement = db.prepare('SELECT * FROM artifacts WHERE id = ?');
  const updateStatement = db.prepare(
    'UPDATE artifacts SET title = ?, project = ?, description = ?, type = ?, updated_at = ? WHERE id = ?',
  );
  const deleteStatement = db.prepare('DELETE FROM artifacts WHERE id = ?');
  const listAllStatement = db.prepare(
    'SELECT * FROM artifacts ORDER BY created_at DESC, rowid DESC',
  );
  const listByProjectStatement = db.prepare(
    'SELECT * FROM artifacts WHERE project = ? ORDER BY created_at DESC, rowid DESC',
  );

  const artifactPath = (id: string, type: ArtifactType): string => join(filesDir, `${id}.${type}`);

  function getRow(id: string): ArtifactRow | undefined {
    const record = selectStatement.get(id);
    return record === undefined ? undefined : toArtifactRow(record);
  }

  // nanoid(10) collisions are astronomically unlikely, but generating an id
  // that already names a row must never happen: writing straight to that id's
  // path would silently overwrite (and, on a later failure, delete) another
  // artifact's content file.
  function generateId(): string {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = nanoid(ID_LENGTH);
      if (!getRow(id)) {
        return id;
      }
    }
    throw new Error(
      `Failed to generate a unique artifact id after ${String(MAX_ID_ATTEMPTS)} attempts`,
    );
  }

  function createArtifact(input: CreateArtifactInput): Artifact {
    assertValidType(input.type);
    assertNonBlank('title', input.title);
    assertNonBlank('project', input.project);
    assertNonBlank('description', input.description);

    const id = generateId();
    const now = isoNow();
    const path = artifactPath(id, input.type);

    // Write the file before the row so a failed insert never leaves a row
    // pointing at a missing file; if the insert throws, the file is removed.
    writeFileSync(path, input.content, 'utf8');
    try {
      insertStatement.run(id, input.title, input.project, input.description, input.type, now, now);
    } catch (error) {
      unlinkSync(path);
      throw error;
    }

    return {
      createdAt: now,
      description: input.description,
      id,
      project: input.project,
      title: input.title,
      type: input.type,
      updatedAt: now,
    };
  }

  function getArtifact(id: string): ArtifactWithContent | null {
    const row = getRow(id);
    if (!row) {
      return null;
    }
    // Deliberately unguarded: a row whose file is missing means the store
    // was corrupted by something outside this module's control (e.g. manual
    // fs tampering), since create/update/remove never leave that state on
    // their own. Letting readFileSync's ENOENT propagate surfaces that loudly
    // instead of masking it as an ordinary "not found".
    const content = readFileSync(artifactPath(row.id, row.type), 'utf8');
    return { ...toArtifact(row), content };
  }

  function updateArtifact(id: string, patch: UpdateArtifactInput): Artifact | null {
    const row = getRow(id);
    if (!row) {
      return null;
    }
    if (patch.type !== undefined) {
      assertValidType(patch.type);
    }
    if (patch.title !== undefined) {
      assertNonBlank('title', patch.title);
    }
    if (patch.project !== undefined) {
      assertNonBlank('project', patch.project);
    }
    if (patch.description !== undefined) {
      assertNonBlank('description', patch.description);
    }

    const nextType = patch.type ?? row.type;
    const oldPath = artifactPath(id, row.type);
    const newPath = artifactPath(id, nextType);

    // Apply the file mutation before the row update, but remember how to
    // reverse it — mirrors createArtifact's write-then-insert ordering, so a
    // failed row update can't leave metadata pointing at a missing/renamed
    // file either.
    let rollbackFile: (() => void) | undefined;
    if (patch.content !== undefined) {
      const previousContent = readFileSync(oldPath, 'utf8');
      writeFileSync(newPath, patch.content, 'utf8');
      if (newPath !== oldPath) {
        unlinkSync(oldPath);
      }
      rollbackFile = () => {
        writeFileSync(oldPath, previousContent, 'utf8');
        if (newPath !== oldPath) {
          unlinkSync(newPath);
        }
      };
    } else if (nextType !== row.type) {
      renameSync(oldPath, newPath);
      rollbackFile = () => {
        renameSync(newPath, oldPath);
      };
    }

    const title = patch.title ?? row.title;
    const project = patch.project ?? row.project;
    const description = patch.description ?? row.description;
    const updatedAt = isoNow();

    try {
      updateStatement.run(title, project, description, nextType, updatedAt, id);
    } catch (error) {
      // If rollbackFile itself throws (e.g. disk failure mid-restore), that
      // new error replaces and masks `error` here — accepted as a
      // catastrophe-only edge case, not worth the complexity of chaining both.
      rollbackFile?.();
      throw error;
    }

    return {
      createdAt: row.created_at,
      description,
      id,
      project,
      title,
      type: nextType,
      updatedAt,
    };
  }

  function removeArtifact(id: string): boolean {
    const row = getRow(id);
    if (!row) {
      return false;
    }
    deleteStatement.run(id);
    // The file always exists alongside a row we control, but tolerate an
    // already-missing file rather than throw on a half-tampered store.
    try {
      unlinkSync(artifactPath(row.id, row.type));
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
    return true;
  }

  function listArtifacts(query: ListArtifactsQuery = {}): Artifact[] {
    const records =
      query.project === undefined
        ? listAllStatement.all()
        : listByProjectStatement.all(query.project);
    return records.map((record) => toArtifact(toArtifactRow(record)));
  }

  return { createArtifact, getArtifact, listArtifacts, removeArtifact, updateArtifact };
}

let defaultStore: ArtifactStore | undefined;

// Lazy so importing this module never touches the filesystem on its own —
// only the app calling getDefaultArtifactStore() does.
export function getDefaultArtifactStore(): ArtifactStore {
  defaultStore ??= createArtifactStore(resolveStoragePaths());
  return defaultStore;
}
