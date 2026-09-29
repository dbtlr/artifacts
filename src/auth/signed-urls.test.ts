import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { SqliteOwnerAuthStore } from '../data/sqlite-owner-auth-store.js';
import {
  createArtifactUrlSigner,
  SIGNED_URL_LIFETIME_SECONDS,
  SIGNING_KEY_BUCKET_SECONDS,
} from './signed-urls.js';
import type { UrlSigningKeyStore } from './types.js';

// Five minutes into a clock hour, so a whole lifetime fits inside it.
const SIGNED_AT = new Date('2026-09-29T12:05:00.000Z');
const HOUR_MS = SIGNING_KEY_BUCKET_SECONDS * 1000;

// The query of a signed path, as a request handler would see it.
function queryOf(path: string): URLSearchParams {
  return new URL(path, 'http://artifacts.invalid').searchParams;
}

function bucketOf(at: Date): number {
  return Math.floor(at.getTime() / HOUR_MS);
}

describe('createArtifactUrlSigner', () => {
  let dataDir: string;
  let databasePath: string;
  let keys: UrlSigningKeyStore;
  let now: Date;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'artifacts-signed-urls-'));
    databasePath = join(dataDir, 'artifacts.db');
    keys = await SqliteOwnerAuthStore.open(databasePath);
    now = SIGNED_AT;
  });

  afterEach(async () => {
    await rm(dataDir, { force: true, recursive: true });
  });

  function signerOver(store: UrlSigningKeyStore = keys) {
    return createArtifactUrlSigner({ keys: store, now: () => now });
  }

  function advance(ms: number): void {
    now = new Date(now.getTime() + ms);
  }

  it('signs a path to one artifact that verifies for that artifact', async () => {
    const signer = signerOver();

    const path = await signer.signedPath('abc_123-XYZ');

    expect(path).toMatch(/^\/a\/abc_123-XYZ\?expires=\d+&signature=[\w-]+$/u);
    await expect(signer.verify('abc_123-XYZ', queryOf(path))).resolves.toBe(true);
  });

  it('expires the signature after its lifetime', async () => {
    const signer = signerOver();
    const query = queryOf(await signer.signedPath('abc'));

    advance((SIGNED_URL_LIFETIME_SECONDS - 1) * 1000);
    await expect(signer.verify('abc', query)).resolves.toBe(true);

    advance(1000);
    await expect(signer.verify('abc', query)).resolves.toBe(false);
  });

  it('signs for a longer lifetime when asked to', async () => {
    const signer = signerOver();
    const query = queryOf(await signer.signedPath('abc', 600));

    advance(599 * 1000);
    await expect(signer.verify('abc', query)).resolves.toBe(true);

    advance(1000);
    await expect(signer.verify('abc', query)).resolves.toBe(false);
  });

  it('grants nothing for another artifact', async () => {
    const signer = signerOver();

    await expect(signer.verify('other', queryOf(await signer.signedPath('abc')))).resolves.toBe(
      false,
    );
  });

  it('refuses a signature with a moved expiry, an altered signature, or a missing part', async () => {
    const signer = signerOver();
    const query = queryOf(await signer.signedPath('abc'));
    const expires = query.get('expires')!;
    const signature = query.get('signature')!;
    const flipped = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;

    const tampered: Record<string, string>[] = [
      { expires: String(Number(expires) + 3600), signature },
      { expires: `${expires}.0`, signature },
      { expires, signature: flipped },
      { expires, signature: signature.slice(0, -2) },
      { expires },
      { signature },
    ];

    const verdicts = await Promise.all(
      tampered.map(async (params) => signer.verify('abc', new URLSearchParams(params))),
    );

    expect(verdicts).toEqual(tampered.map(() => false));
  });

  it('refuses a signature made with another database’s key', async () => {
    const otherDir = await mkdtemp(join(tmpdir(), 'artifacts-signed-urls-other-'));
    try {
      const other = signerOver(await SqliteOwnerAuthStore.open(join(otherDir, 'artifacts.db')));

      await expect(
        signerOver().verify('abc', queryOf(await other.signedPath('abc'))),
      ).resolves.toBe(false);
    } finally {
      await rm(otherDir, { force: true, recursive: true });
    }
  });

  it('refuses to sign an id that is not an artifact id', async () => {
    await expect(signerOver().signedPath('../etc')).rejects.toThrow(/not an artifact id/u);
  });

  it('converges on one key when instances sharing a database sign at once', async () => {
    const first = signerOver();
    const second = signerOver(await SqliteOwnerAuthStore.open(databasePath));

    const [fromFirst, fromSecond] = await Promise.all([
      first.signedPath('abc'),
      second.signedPath('abc'),
    ]);

    expect(fromFirst).toBe(fromSecond);
    await expect(first.verify('abc', queryOf(fromSecond))).resolves.toBe(true);
    await expect(second.verify('abc', queryOf(fromFirst))).resolves.toBe(true);
  });

  it('keeps a URL signed just before the hour working into the next hour', async () => {
    now = new Date(Math.ceil(SIGNED_AT.getTime() / HOUR_MS) * HOUR_MS - 60_000);
    const signer = signerOver();
    const query = queryOf(await signer.signedPath('abc', 600));

    advance(5 * 60_000);
    await expect(signer.verify('abc', query)).resolves.toBe(true);
    // Another instance, which never signed in the previous hour, agrees.
    const fresh = signerOver(await SqliteOwnerAuthStore.open(databasePath));
    await expect(fresh.verify('abc', query)).resolves.toBe(true);
  });

  it('refuses a URL signed two hours back, whatever its expiry says', async () => {
    const signer = signerOver();
    const query = queryOf(await signer.signedPath('abc', 3 * SIGNING_KEY_BUCKET_SECONDS));

    advance(HOUR_MS);
    await expect(signer.verify('abc', query)).resolves.toBe(true);

    advance(HOUR_MS);
    await expect(signer.verify('abc', query)).resolves.toBe(false);
  });

  it('prunes keys older than the previous hour when the next key is made', async () => {
    const signer = signerOver();
    const firstBucket = bucketOf(now);
    await signer.signedPath('abc');

    advance(HOUR_MS);
    await signer.signedPath('abc');
    await expect(keys.findUrlSigningKey(firstBucket)).resolves.not.toBeNull();

    advance(HOUR_MS);
    await signer.signedPath('abc');
    await expect(keys.findUrlSigningKey(firstBucket)).resolves.toBeNull();
    await expect(keys.findUrlSigningKey(firstBucket + 1)).resolves.not.toBeNull();
  });
});
