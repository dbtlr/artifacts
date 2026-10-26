import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { SqliteSecretStore } from '../data/sqlite-secret-store.js';
import { toBase64Url } from './crypto.js';
import { InvalidSecretInputError, SecretLimitError } from './errors.js';
import {
  CLAIM_LIFETIME_SECONDS,
  createSecretService,
  DEFAULT_TTL_SECONDS,
  SECRET_LIMIT,
  TOMBSTONE_SECONDS,
  UPLOAD_SLOT_LIFETIME_SECONDS,
} from './service.js';
import type { CreateSecretInput, SecretService } from './types.js';

const START = new Date('2026-01-01T00:00:00.000Z');
const content = new TextEncoder().encode('correct horse battery staple');
// A well-formed key that opens nothing.
const otherKey = toBase64Url(new Uint8Array(32).fill(7));

let directory: string;
let databasePath: string;
let clock: Date;
let service: SecretService;

function advance(seconds: number): void {
  clock = new Date(clock.getTime() + seconds * 1000);
}

function inSeconds(seconds: number): string {
  return new Date(clock.getTime() + seconds * 1000).toISOString();
}

// Distinct, repeatable bytes: each call's count leads, then a fixed pattern.
function sequentialRandomBytes(): (length: number) => Uint8Array<ArrayBuffer> {
  let call = 0;
  return (length) => {
    call += 1;
    const bytes = new Uint8Array(length).map((_byte, index) => (index * 37 + 11) % 256);
    new DataView(bytes.buffer).setUint32(0, call);
    return bytes;
  };
}

function rows(table: string): Record<string, unknown>[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(`SELECT * FROM ${table}`).all();
  } finally {
    database.close();
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'muninn-secrets-'));
  databasePath = join(directory, 'muninn.db');
  clock = START;
  service = createSecretService({
    now: () => clock,
    randomBytes: sequentialRandomBytes(),
    store: await SqliteSecretStore.open(databasePath),
  });
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe('SecretService uploads', () => {
  it('creates an upload slot that lasts 15 minutes and is not a secret', async () => {
    const { expiresAt, uploadToken } = await service.createUpload({ label: 'Deploy token' });

    expect(uploadToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(expiresAt).toBe(inSeconds(UPLOAD_SLOT_LIFETIME_SECONDS));
    expect(rows('secrets')).toEqual([]);
    await expect(service.status(uploadToken)).resolves.toBe('unknown');
  });

  it('turns an upload into a secret named by its slot', async () => {
    const { uploadToken } = await service.createUpload({
      filename: 'token.txt',
      label: 'Deploy token',
      ttlSeconds: 7200,
    });
    advance(60);

    const created = await service.upload(uploadToken, content);

    expect(created?.id).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(created?.key).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created?.expiresAt).toBe(inSeconds(7200));
    await expect(service.reveal(created?.id ?? '', created?.key ?? '')).resolves.toEqual({
      content,
      filename: 'token.txt',
      label: 'Deploy token',
    });
  });

  it('uses an upload slot once', async () => {
    const { uploadToken } = await service.createUpload({ label: 'Once' });
    await service.upload(uploadToken, content);

    await expect(service.upload(uploadToken, content)).resolves.toBeNull();
    expect(rows('secrets')).toHaveLength(1);
  });

  it('lets only one of two concurrent uploads use a slot', async () => {
    const { uploadToken } = await service.createUpload({ label: 'Race' });

    const results = await Promise.all([
      service.upload(uploadToken, content),
      service.upload(uploadToken, content),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(rows('secrets')).toHaveLength(1);
  });

  it('refuses an unknown or expired upload token', async () => {
    const { uploadToken } = await service.createUpload({ label: 'Late' });
    advance(UPLOAD_SLOT_LIFETIME_SECONDS);

    await expect(service.upload(uploadToken, content)).resolves.toBeNull();
    await expect(service.upload(otherKey, content)).resolves.toBeNull();
    await expect(service.upload('', content)).resolves.toBeNull();
  });

  it('keeps the slot when the upload breaks a limit', async () => {
    const { uploadToken } = await service.createUpload({ label: 'Retry' });

    await expect(service.upload(uploadToken, new Uint8Array())).rejects.toThrow(
      InvalidSecretInputError,
    );

    await expect(service.upload(uploadToken, content)).resolves.not.toBeNull();
  });
});

describe('SecretService reveal', () => {
  it('creates a secret that lasts a day by default and describes it without its key', async () => {
    const { expiresAt, id } = await service.create({ content, label: 'Owner secret' });

    expect(expiresAt).toBe(inSeconds(DEFAULT_TTL_SECONDS));
    await expect(service.find(id)).resolves.toEqual({
      expiresAt,
      filename: null,
      label: 'Owner secret',
    });
    await expect(service.status(id)).resolves.toBe('pending');
  });

  it('reveals a secret once', async () => {
    const { id, key } = await service.create({ content, filename: 'a.txt', label: 'Once' });

    await expect(service.reveal(id, key)).resolves.toEqual({
      content,
      filename: 'a.txt',
      label: 'Once',
    });
    await expect(service.reveal(id, key)).resolves.toBeNull();
    await expect(service.find(id)).resolves.toBeNull();
    await expect(service.status(id)).resolves.toBe('read');
  });

  it('does not burn a secret on a wrong key', async () => {
    const { id, key } = await service.create({ content, label: 'Guarded' });
    const other = await service.create({ content, label: 'Other' });

    await expect(service.reveal(id, otherKey)).resolves.toBeNull();
    await expect(service.reveal(id, other.key)).resolves.toBeNull();
    await expect(service.reveal(id, 'not a key')).resolves.toBeNull();
    await expect(service.reveal(id, '')).resolves.toBeNull();

    await expect(service.status(id)).resolves.toBe('pending');
    await expect(service.reveal(id, key)).resolves.toMatchObject({ content });
  });

  it('lets only one of two concurrent reveals read a secret', async () => {
    const { id, key } = await service.create({ content, label: 'Race' });

    const results = await Promise.all([service.reveal(id, key), service.reveal(id, key)]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  it('does not reveal an expired secret', async () => {
    const { id, key } = await service.create({ content, label: 'Stale', ttlSeconds: 3600 });
    advance(3600);

    await expect(service.reveal(id, key)).resolves.toBeNull();
    await expect(service.claim(id, key)).resolves.toBeNull();
    await expect(service.find(id)).resolves.toBeNull();
    await expect(service.status(id)).resolves.toBe('expired');
  });

  it.each(['AAAAAAAAAAAAAAAAAAAAAA', '../escape', ''])(
    'reads the unknown or malformed id %j as unknown',
    async (id) => {
      const { key } = await service.create({ content, label: 'Real' });

      await expect(service.find(id)).resolves.toBeNull();
      await expect(service.reveal(id, key)).resolves.toBeNull();
      await expect(service.claim(id, key)).resolves.toBeNull();
      await expect(service.status(id)).resolves.toBe('unknown');
    },
  );
});

describe('SecretService claims', () => {
  it('claims a secret without reading it and downloads it once', async () => {
    const { id, key } = await service.create({ content, filename: 'b.txt', label: 'Claimed' });

    const claim = await service.claim(id, key);

    expect(claim?.claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(claim?.expiresAt).toBe(inSeconds(CLAIM_LIFETIME_SECONDS));
    await expect(service.status(id)).resolves.toBe('pending');
    await expect(service.download(claim?.claimToken ?? '')).resolves.toEqual({
      content,
      filename: 'b.txt',
      label: 'Claimed',
    });
    await expect(service.download(claim?.claimToken ?? '')).resolves.toBeNull();
    await expect(service.status(id)).resolves.toBe('read');
  });

  it('refuses a claim with a wrong key and leaves the secret unread', async () => {
    const { id, key } = await service.create({ content, label: 'Guarded' });

    await expect(service.claim(id, otherKey)).resolves.toBeNull();
    await expect(service.claim(id, 'not a key')).resolves.toBeNull();

    expect(rows('secret_claims')).toEqual([]);
    await expect(service.reveal(id, key)).resolves.toMatchObject({ content });
  });

  it('lets only one of two concurrent downloads use a claim', async () => {
    const { id, key } = await service.create({ content, label: 'Race' });
    const claim = await service.claim(id, key);
    const token = claim?.claimToken ?? '';

    const results = await Promise.all([service.download(token), service.download(token)]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  it('lets only one of two claims on a secret download it', async () => {
    const { id, key } = await service.create({ content, label: 'Race' });
    const first = await service.claim(id, key);
    const second = await service.claim(id, key);

    const results = await Promise.all([
      service.download(first?.claimToken ?? ''),
      service.download(second?.claimToken ?? ''),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  it('refuses an unknown or expired claim and leaves the secret unread', async () => {
    const { id, key } = await service.create({ content, label: 'Late' });
    const claim = await service.claim(id, key);
    advance(CLAIM_LIFETIME_SECONDS);

    await expect(service.download(claim?.claimToken ?? '')).resolves.toBeNull();
    await expect(service.download(otherKey)).resolves.toBeNull();
    await expect(service.download('')).resolves.toBeNull();
    await expect(service.status(id)).resolves.toBe('pending');
  });
});

describe('SecretService storage', () => {
  it('stores no plaintext, no data key, and no token', async () => {
    const plaintext = 'plaintext-that-must-never-be-stored';
    const bytes = new TextEncoder().encode(plaintext);
    const owned = await service.create({ content: bytes, label: 'Owned' });
    const claim = await service.claim(owned.id, owned.key);
    const { uploadToken } = await service.createUpload({ label: 'Pending upload' });
    const used = await service.createUpload({ label: 'Uploaded' });
    const uploaded = await service.upload(used.uploadToken, bytes);

    const stored = JSON.stringify(
      ['secrets', 'secret_upload_slots', 'secret_claims'].flatMap(rows),
    );

    const forbidden = [
      plaintext,
      toBase64Url(bytes),
      Buffer.from(bytes).toString('base64'),
      Buffer.from(bytes).toString('hex'),
      owned.key,
      uploaded?.key ?? 'missing upload',
      claim?.claimToken ?? 'missing claim',
      uploadToken,
      used.uploadToken,
    ];
    for (const value of forbidden) {
      expect(stored).not.toContain(value);
    }
    for (const key of [owned.key, uploaded?.key ?? '']) {
      const raw = Buffer.from(key, 'base64url');
      expect(stored).not.toContain(raw.toString('hex'));
      expect(stored).not.toContain(raw.toString('base64'));
    }
  });

  it('drops the ciphertext of a read secret', async () => {
    const { id, key } = await service.create({ content, label: 'Read' });

    await service.reveal(id, key);

    expect(rows('secrets')).toMatchObject([{ ciphertext: null, id }]);
  });

  it('sweeps expired slots, claims, and contents, then old tombstones', async () => {
    await service.createUpload({ label: 'Abandoned' });
    const read = await service.create({ content, label: 'Read', ttlSeconds: 7200 });
    await service.claim(read.id, read.key);
    await service.reveal(read.id, read.key);
    const expired = await service.create({ content, label: 'Expired', ttlSeconds: 3600 });
    const pending = await service.create({ content, label: 'Pending', ttlSeconds: 604_800 });
    advance(3600);

    await service.sweep();

    expect(rows('secret_upload_slots')).toEqual([]);
    expect(rows('secret_claims')).toEqual([]);
    expect(rows('secrets')).toHaveLength(3);
    expect(rows('secrets').find((row) => row.id === expired.id)).toMatchObject({
      ciphertext: null,
    });
    await expect(service.status(read.id)).resolves.toBe('read');
    await expect(service.status(expired.id)).resolves.toBe('expired');

    advance(TOMBSTONE_SECONDS);
    await service.sweep();

    await expect(service.status(read.id)).resolves.toBe('unknown');
    await expect(service.status(expired.id)).resolves.toBe('unknown');
    await expect(service.reveal(pending.id, pending.key)).resolves.toMatchObject({ content });
  });

  it('sweeps as of the time it is given', async () => {
    const { id } = await service.create({ content, label: 'Expired', ttlSeconds: 3600 });

    await service.sweep(new Date(clock.getTime() + 3600 * 1000));

    expect(rows('secrets')).toMatchObject([{ ciphertext: null, id }]);
  });
});

describe('SecretService limits', () => {
  const valid = { content, label: 'Valid' };

  async function rejection(input: Partial<CreateSecretInput>) {
    const error: unknown = await service.create({ ...valid, ...input }).catch((caught) => caught);
    expect(error).toBeInstanceOf(InvalidSecretInputError);
    return error instanceof InvalidSecretInputError ? error.field : undefined;
  }

  it.each(['', '   ', 'x'.repeat(101), ` ${'x'.repeat(101)} `])(
    'refuses the label %j',
    async (label) => {
      await expect(rejection({ label })).resolves.toBe('label');
      await expect(service.createUpload({ label })).rejects.toThrow(InvalidSecretInputError);
    },
  );

  it('accepts a label of up to 100 characters after trimming', async () => {
    const { id } = await service.create({ ...valid, label: `  ${'é'.repeat(100)}  ` });

    await expect(service.find(id)).resolves.toMatchObject({ label: 'é'.repeat(100) });
  });

  it.each([
    '',
    '.',
    '..',
    'nested/file.txt',
    String.raw`nested\file.txt`,
    'line\nbreak.txt',
    'tab\tname',
    'delete\u007F',
    ' padded.txt',
    'x'.repeat(256),
  ])('refuses the filename %j', async (filename) => {
    await expect(rejection({ filename })).resolves.toBe('filename');
    await expect(service.createUpload({ filename, label: 'Upload' })).rejects.toThrow(
      InvalidSecretInputError,
    );
  });

  it('accepts a filename of up to 255 characters', async () => {
    const filename = `${'x'.repeat(251)}.pem`;

    const { id } = await service.create({ ...valid, filename });

    await expect(service.find(id)).resolves.toMatchObject({ filename });
  });

  it.each([0, 65_537])('refuses %d bytes of content', async (length) => {
    await expect(rejection({ content: new Uint8Array(length) })).resolves.toBe('content');
  });

  it('accepts 65536 bytes of content', async () => {
    const large = new Uint8Array(65_536).fill(1);
    const { id, key } = await service.create({ ...valid, content: large });

    await expect(service.reveal(id, key)).resolves.toMatchObject({ content: large });
  });

  it.each([3599, 604_801, 3600.5, Number.NaN])('refuses a ttl of %d seconds', async (ttl) => {
    await expect(rejection({ ttlSeconds: ttl })).resolves.toBe('ttlSeconds');
    await expect(service.createUpload({ label: 'Upload', ttlSeconds: ttl })).rejects.toThrow(
      InvalidSecretInputError,
    );
  });

  it.each([3600, 604_800])('accepts a ttl of %d seconds', async (ttl) => {
    const { expiresAt } = await service.create({ ...valid, ttlSeconds: ttl });

    expect(expiresAt).toBe(inSeconds(ttl));
  });

  it('refuses secrets and upload slots past the limit until one is read', async () => {
    const { id, key } = await service.create(valid);
    const { uploadToken } = await service.createUpload({ label: 'Held' });
    await Promise.all(
      Array.from({ length: SECRET_LIMIT - 2 }, (_slot, index) =>
        service.createUpload({ label: `Slot ${String(index)}` }),
      ),
    );

    await expect(service.create(valid)).rejects.toThrow(SecretLimitError);
    await expect(service.createUpload({ label: 'Over' })).rejects.toThrow(SecretLimitError);
    // A slot already holds its place, so its upload still succeeds.
    await expect(service.upload(uploadToken, content)).resolves.not.toBeNull();

    await service.reveal(id, key);
    await expect(service.create(valid)).resolves.toMatchObject({ id: expect.any(String) });
  });
});
