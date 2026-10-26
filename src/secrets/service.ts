import { isSafeFilename, MAX_FILENAME_LENGTH } from '../filenames.js';
import {
  decodeKey,
  decrypt,
  deriveClaimKey,
  encrypt,
  fromBase64Url,
  hashToken,
  toBase64Url,
} from './crypto.js';
import { InvalidSecretInputError, SecretLimitError } from './errors.js';
import { isSecretId } from './handle.js';
import type {
  CreateSecretInput,
  CreatedSecret,
  RevealedSecret,
  SecretAdmission,
  SecretService,
  SecretStore,
  SecretUploadInput,
  StoredSecret,
} from './types.js';

export const UPLOAD_SLOT_LIFETIME_SECONDS = 15 * 60;
export const CLAIM_LIFETIME_SECONDS = 5 * 60;
export const MIN_TTL_SECONDS = 60 * 60;
export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
export const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
// A read or expired secret's row stays this long, so its status still says
// what happened to it, before a sweep removes it.
export const TOMBSTONE_SECONDS = 24 * 60 * 60;
// Unread, unexpired secrets and upload slots together.
export const SECRET_LIMIT = 1000;
// Unexpired claims on one secret.
export const CLAIMS_PER_SECRET = 5;
// In code points, so combining marks cannot stretch one character.
export const MAX_LABEL_LENGTH = 100;
export const MAX_SECRET_BYTES = 65_536;

const ID_BYTES = 16;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

// A secret's checked input, before it is encrypted.
type NewSecret = {
  content: Uint8Array;
  filename: string | null;
  label: string;
  ttlSeconds: number;
};

type SecretServiceOptions = {
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array<ArrayBuffer>;
  store: SecretStore;
};

function cryptoRandomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

// Control and format characters, which include bidi overrides that can
// make a label display as something else, and line and paragraph separators.
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function codePointCount(value: string): number {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
  }
  return count;
}

// The trimmed label, of 1 to MAX_LABEL_LENGTH code points.
function validLabel(label: string): string {
  const trimmed = label.trim();
  const length = codePointCount(trimmed);
  if (length < 1 || length > MAX_LABEL_LENGTH || CONTROL_OR_FORMAT.test(trimmed)) {
    throw new InvalidSecretInputError(
      'label',
      `A secret label must be 1 to ${String(MAX_LABEL_LENGTH)} characters, with no control or format characters`,
    );
  }
  return trimmed;
}

// A name to save the secret under: one plain path segment, never a path.
function validFilename(filename: string | undefined): string | null {
  if (filename === undefined) {
    return null;
  }
  if (!isSafeFilename(filename)) {
    throw new InvalidSecretInputError(
      'filename',
      `A secret filename must be a safe file name of at most ${String(MAX_FILENAME_LENGTH)} characters`,
    );
  }
  return filename;
}

function validTtl(ttlSeconds = DEFAULT_TTL_SECONDS): number {
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < MIN_TTL_SECONDS ||
    ttlSeconds > MAX_TTL_SECONDS
  ) {
    throw new InvalidSecretInputError(
      'ttlSeconds',
      `A secret must live ${String(MIN_TTL_SECONDS)} to ${String(MAX_TTL_SECONDS)} whole seconds`,
    );
  }
  return ttlSeconds;
}

function assertValidContent(content: Uint8Array): void {
  if (content.byteLength < 1 || content.byteLength > MAX_SECRET_BYTES) {
    throw new InvalidSecretInputError(
      'content',
      `A secret must hold 1 to ${String(MAX_SECRET_BYTES)} bytes`,
    );
  }
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

// Bytes a store row holds as base64url, which only a corrupt row lacks.
function storedBytes(value: string, what: string): Uint8Array<ArrayBuffer> {
  const bytes = fromBase64Url(value);
  if (bytes === null) {
    throw new TypeError(`Corrupt secret row: ${what} is not base64url`);
  }
  return bytes;
}

// One-time secrets over a SecretStore (ADR-0008). Each secret is encrypted
// under a fresh random key that only the caller receives. Every failed read
// resolves null, whatever the reason.
export function createSecretService({
  now = () => new Date(),
  randomBytes = cryptoRandomBytes,
  store,
}: SecretServiceOptions): SecretService {
  function admissionAt(at: Date): SecretAdmission {
    return { limit: SECRET_LIMIT, now: at.toISOString() };
  }

  // Encrypts a new secret and stores it with `insert`, which resolves whether
  // the store took it. Resolves null when it did not.
  async function storeSecret(
    { content, filename, label, ttlSeconds }: NewSecret,
    insert: (secret: StoredSecret, at: Date) => Promise<boolean>,
  ): Promise<CreatedSecret | null> {
    const at = now();
    const id = toBase64Url(randomBytes(ID_BYTES));
    const key = randomBytes(KEY_BYTES);
    const nonce = randomBytes(NONCE_BYTES);
    const ciphertext = await encrypt(key, nonce, id, new Uint8Array(content));
    const expiresAt = addSeconds(at, ttlSeconds).toISOString();
    const stored = await insert(
      {
        ciphertext: toBase64Url(ciphertext),
        createdAt: at.toISOString(),
        expiresAt,
        filename,
        id,
        label,
        nonce: toBase64Url(nonce),
      },
      at,
    );
    return stored ? { expiresAt, id, key: toBase64Url(key) } : null;
  }

  // The pending secret and its contents when `key` opens it, without
  // burning it.
  async function open(
    id: string,
    key: Uint8Array<ArrayBuffer>,
  ): Promise<{ content: Uint8Array<ArrayBuffer>; secret: StoredSecret } | null> {
    if (!isSecretId(id)) {
      return null;
    }
    const secret = await store.findPendingSecret(id, now().toISOString());
    if (secret === null) {
      return null;
    }
    const content = await decrypt(
      key,
      storedBytes(secret.nonce, 'nonce'),
      id,
      storedBytes(secret.ciphertext, 'ciphertext'),
    );
    return content === null ? null : { content, secret };
  }

  // Decrypts first, so a wrong key burns nothing, then consumes the secret:
  // of two reveals that both decrypt, only the one that consumes it returns
  // the contents.
  async function revealWith(
    id: string,
    key: Uint8Array<ArrayBuffer>,
  ): Promise<RevealedSecret | null> {
    const opened = await open(id, key);
    if (opened === null || !(await store.consumeSecret(id, now().toISOString()))) {
      return null;
    }
    const { content, secret } = opened;
    return { content, filename: secret.filename, label: secret.label };
  }

  async function createUpload(input: SecretUploadInput) {
    const label = validLabel(input.label);
    const filename = validFilename(input.filename);
    const ttlSeconds = validTtl(input.ttlSeconds);
    const at = now();
    const uploadToken = toBase64Url(randomBytes(KEY_BYTES));
    const expiresAt = addSeconds(at, UPLOAD_SLOT_LIFETIME_SECONDS).toISOString();
    const stored = await store.createUploadSlot(
      { expiresAt, filename, label, tokenHash: await hashToken(uploadToken), ttlSeconds },
      admissionAt(at),
    );
    if (!stored) {
      throw new SecretLimitError(SECRET_LIMIT);
    }
    return { expiresAt, uploadToken };
  }

  // The content is checked before the slot is taken, so an upload that
  // breaks a limit can be retried. Taking the slot marks it used, and it
  // keeps its place under the limit until the secret is stored. The secret is
  // stored only while the slot exists, so an upload whose expired slot a sweep
  // removed resolves null. A failed upload leaves the used slot for the sweep.
  async function upload(uploadToken: string, content: Uint8Array) {
    assertValidContent(content);
    if (decodeKey(uploadToken) === null) {
      return null;
    }
    const tokenHash = await hashToken(uploadToken);
    const slot = await store.takeUploadSlot(tokenHash, now().toISOString());
    if (slot === null) {
      return null;
    }
    const { filename, label, ttlSeconds } = slot;
    const created = await storeSecret({ content, filename, label, ttlSeconds }, (secret) =>
      store.createUploadedSecret(secret, tokenHash),
    );
    if (created !== null) {
      await store.removeUploadSlot(tokenHash);
    }
    return created;
  }

  async function create(input: CreateSecretInput) {
    const label = validLabel(input.label);
    const filename = validFilename(input.filename);
    const ttlSeconds = validTtl(input.ttlSeconds);
    assertValidContent(input.content);
    const created = await storeSecret(
      { content: input.content, filename, label, ttlSeconds },
      (secret, at) => store.createSecret(secret, admissionAt(at)),
    );
    if (created === null) {
      throw new SecretLimitError(SECRET_LIMIT);
    }
    return created;
  }

  async function find(id: string) {
    if (!isSecretId(id)) {
      return null;
    }
    const secret = await store.findPendingSecret(id, now().toISOString());
    return secret === null
      ? null
      : { expiresAt: secret.expiresAt, filename: secret.filename, label: secret.label };
  }

  async function reveal(id: string, key: string) {
    const keyBytes = decodeKey(key);
    return keyBytes === null ? null : revealWith(id, keyBytes);
  }

  // Wraps the data key under a key derived from a fresh claim token, so the
  // claim row holds nothing usable without the token. A secret has at most
  // CLAIMS_PER_SECRET unexpired claims.
  async function claim(id: string, key: string) {
    const keyBytes = decodeKey(key);
    if (keyBytes === null || (await open(id, keyBytes)) === null) {
      return null;
    }
    const claimToken = randomBytes(KEY_BYTES);
    const nonce = randomBytes(NONCE_BYTES);
    const wrappedKey = await encrypt(await deriveClaimKey(claimToken), nonce, id, keyBytes);
    const token = toBase64Url(claimToken);
    const at = now();
    const expiresAt = addSeconds(at, CLAIM_LIFETIME_SECONDS).toISOString();
    const stored = await store.createClaim(
      {
        expiresAt,
        nonce: toBase64Url(nonce),
        secretId: id,
        tokenHash: await hashToken(token),
        wrappedKey: toBase64Url(wrappedKey),
      },
      { limit: CLAIMS_PER_SECRET, now: at.toISOString() },
    );
    return stored ? { claimToken: token, expiresAt } : null;
  }

  async function download(claimToken: string) {
    const tokenBytes = decodeKey(claimToken);
    if (tokenBytes === null) {
      return null;
    }
    const stored = await store.takeClaim(await hashToken(claimToken), now().toISOString());
    if (stored === null) {
      return null;
    }
    const key = await decrypt(
      await deriveClaimKey(tokenBytes),
      storedBytes(stored.nonce, 'nonce'),
      stored.secretId,
      storedBytes(stored.wrappedKey, 'wrapped_key'),
    );
    return key === null ? null : revealWith(stored.secretId, key);
  }

  async function status(id: string) {
    const state = isSecretId(id) ? await store.findSecretState(id) : null;
    if (state === null) {
      return 'unknown' as const;
    }
    if (state.readAt !== null) {
      return 'read' as const;
    }
    return state.expiresAt <= now().toISOString() ? ('expired' as const) : ('pending' as const);
  }

  async function sweep() {
    const at = now();
    await store.sweep(at.toISOString(), addSeconds(at, -TOMBSTONE_SECONDS).toISOString());
  }

  return { claim, create, createUpload, download, find, reveal, status, sweep, upload };
}
