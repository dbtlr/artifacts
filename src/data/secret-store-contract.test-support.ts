import { describe, expect, it } from 'vite-plus/test';

import type { SecretStore, StoredClaim, StoredSecret, StoredUploadSlot } from '../secrets/types.js';

export type SecretTable = 'secret_claims' | 'secret_upload_slots' | 'secrets';

// A store under test and a raw view of the tables behind it, for checks the
// store's own methods cannot make.
export type SecretStoreHarness = {
  rows: (table: SecretTable) => Promise<Record<string, unknown>[]>;
  store: SecretStore;
};

// Hours after a fixed start, as the ISO text the store compares.
function at(hours: number): string {
  return new Date(Date.UTC(2026, 0, 1) + hours * 3_600_000).toISOString();
}

function secretNamed(id: string, expiresAt = at(24)): StoredSecret {
  return {
    ciphertext: `ciphertext-of-${id}`,
    createdAt: at(0),
    expiresAt,
    filename: null,
    id,
    label: `Label ${id}`,
    nonce: `nonce-of-${id}`,
  };
}

const secret: StoredSecret = { ...secretNamed('secret-one'), filename: 'token.txt' };

function slotNamed(tokenHash: string, expiresAt = at(1)): StoredUploadSlot {
  return { expiresAt, filename: 'key.pem', label: 'Signing key', tokenHash, ttlSeconds: 3600 };
}

function claimNamed(tokenHash: string, expiresAt = at(1)): StoredClaim {
  return { expiresAt, nonce: 'claim-nonce', secretId: secret.id, tokenHash, wrappedKey: 'wrapped' };
}

export function secretStoreContract(
  name: string,
  createHarness: () => Promise<SecretStoreHarness>,
): void {
  describe(`${name} secret store contract`, () => {
    it('finds a secret while it is unread and unexpired', async () => {
      const { store } = await createHarness();

      await expect(store.createSecret(secret)).resolves.toBe(true);

      await expect(store.findPendingSecret(secret.id, at(23))).resolves.toEqual(secret);
      await expect(store.findPendingSecret(secret.id, at(24))).resolves.toBeNull();
      await expect(store.findPendingSecret('missing', at(0))).resolves.toBeNull();
      await expect(store.findSecretState(secret.id)).resolves.toEqual({
        expiresAt: secret.expiresAt,
        readAt: null,
      });
      await expect(store.findSecretState('missing')).resolves.toBeNull();
    });

    it('consumes a secret once and drops its ciphertext', async () => {
      const { rows, store } = await createHarness();
      await store.createSecret(secret);

      const results = await Promise.all([
        store.consumeSecret(secret.id, at(1)),
        store.consumeSecret(secret.id, at(1)),
      ]);

      expect(results.filter((consumed) => consumed)).toEqual([true]);
      await expect(store.findPendingSecret(secret.id, at(1))).resolves.toBeNull();
      await expect(store.findSecretState(secret.id)).resolves.toEqual({
        expiresAt: secret.expiresAt,
        readAt: at(1),
      });
      expect(await rows('secrets')).toMatchObject([{ ciphertext: null, id: secret.id }]);
    });

    it('does not consume an expired secret', async () => {
      const { store } = await createHarness();
      await store.createSecret(secret);

      await expect(store.consumeSecret(secret.id, secret.expiresAt)).resolves.toBe(false);
      await expect(store.consumeSecret('missing', at(0))).resolves.toBe(false);
      await expect(store.findSecretState(secret.id)).resolves.toMatchObject({ readAt: null });
    });

    it('rejects a secret under a taken id and keeps the stored row', async () => {
      const { rows, store } = await createHarness();
      await store.createSecret(secret);

      await expect(store.createSecret({ ...secret, label: 'Other' })).rejects.toThrow();

      expect(await rows('secrets')).toMatchObject([{ label: secret.label }]);
    });

    it('admits live secrets and upload slots together up to the limit', async () => {
      const { rows, store } = await createHarness();
      const admission = { limit: 2, now: at(0) };

      await expect(store.createSecret(secretNamed('first'), admission)).resolves.toBe(true);
      await expect(store.createUploadSlot(slotNamed('slot-one'), admission)).resolves.toBe(true);
      await expect(store.createSecret(secretNamed('second'), admission)).resolves.toBe(false);
      await expect(store.createUploadSlot(slotNamed('slot-two'), admission)).resolves.toBe(false);

      expect(await rows('secrets')).toHaveLength(1);
      expect(await rows('secret_upload_slots')).toHaveLength(1);
    });

    it('does not count read or expired secrets and slots against the limit', async () => {
      const { store } = await createHarness();
      await store.createSecret(secretNamed('read'));
      await store.consumeSecret('read', at(0));
      await store.createSecret(secretNamed('expired', at(1)));
      await store.createUploadSlot(slotNamed('expired-slot', at(1)), { limit: 9, now: at(0) });

      await expect(
        store.createSecret(secretNamed('admitted'), { limit: 1, now: at(1) }),
      ).resolves.toBe(true);
      await expect(
        store.createUploadSlot(slotNamed('refused'), { limit: 1, now: at(1) }),
      ).resolves.toBe(false);
    });

    // An upload turns a slot, which already holds its place under the limit,
    // into a secret.
    it('stores a secret without an admission whatever the count', async () => {
      const { store } = await createHarness();
      await store.createSecret(secretNamed('first'));

      await expect(store.createSecret(secretNamed('second'))).resolves.toBe(true);
      await expect(
        store.createSecret(secretNamed('third'), { limit: 2, now: at(0) }),
      ).resolves.toBe(false);
    });

    it('gives an upload slot to only one taker', async () => {
      const { rows, store } = await createHarness();
      const slot = slotNamed('slot-hash');
      await store.createUploadSlot(slot, { limit: 9, now: at(0) });

      const taken = await Promise.all([
        store.takeUploadSlot(slot.tokenHash, at(0)),
        store.takeUploadSlot(slot.tokenHash, at(0)),
      ]);

      expect(taken.filter((value) => value !== null)).toEqual([slot]);
      expect(await rows('secret_upload_slots')).toEqual([]);
      await expect(store.takeUploadSlot('missing', at(0))).resolves.toBeNull();
    });

    it('does not give out an expired upload slot', async () => {
      const { store } = await createHarness();
      const slot = slotNamed('slot-hash');
      await store.createUploadSlot(slot, { limit: 9, now: at(0) });

      await expect(store.takeUploadSlot(slot.tokenHash, slot.expiresAt)).resolves.toBeNull();
    });

    it('gives a claim to only one taker', async () => {
      const { rows, store } = await createHarness();
      const claim = claimNamed('claim-hash');
      await store.createClaim(claim);

      const taken = await Promise.all([
        store.takeClaim(claim.tokenHash, at(0)),
        store.takeClaim(claim.tokenHash, at(0)),
      ]);

      expect(taken.filter((value) => value !== null)).toEqual([claim]);
      expect(await rows('secret_claims')).toEqual([]);
      await expect(store.takeClaim('missing', at(0))).resolves.toBeNull();
    });

    it('does not give out an expired claim', async () => {
      const { store } = await createHarness();
      const claim = claimNamed('claim-hash');
      await store.createClaim(claim);

      await expect(store.takeClaim(claim.tokenHash, claim.expiresAt)).resolves.toBeNull();
    });

    it('sweeps expired slots, claims, and ciphertext, and old tombstones', async () => {
      const { rows, store } = await createHarness();
      const admission = { limit: 9, now: at(0) };
      await store.createUploadSlot(slotNamed('slot-expired', at(1)), admission);
      await store.createUploadSlot(slotNamed('slot-live', at(3)), admission);
      await store.createClaim(claimNamed('claim-expired', at(1)));
      await store.createClaim(claimNamed('claim-live', at(3)));
      await store.createSecret(secretNamed('pending', at(30)));
      await store.createSecret(secretNamed('expired-recently', at(2)));
      await store.createSecret(secretNamed('expired-long-ago', at(-30)));
      await store.createSecret(secretNamed('read-recently', at(30)));
      await store.consumeSecret('read-recently', at(1));
      await store.createSecret(secretNamed('read-long-ago', at(30)));
      await store.consumeSecret('read-long-ago', at(-30));

      await store.sweep(at(2), at(-24));

      expect((await rows('secret_upload_slots')).map((row) => row.token_hash)).toEqual([
        'slot-live',
      ]);
      expect((await rows('secret_claims')).map((row) => row.token_hash)).toEqual(['claim-live']);
      const secrets = (await rows('secrets')).map(({ ciphertext, id }) => ({ ciphertext, id }));
      expect(
        secrets.toSorted((left, right) => String(left.id).localeCompare(String(right.id))),
      ).toEqual([
        { ciphertext: null, id: 'expired-recently' },
        { ciphertext: 'ciphertext-of-pending', id: 'pending' },
        { ciphertext: null, id: 'read-recently' },
      ]);
    });
  });
}
