import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { z } from 'zod';

import { SqliteSecretStore } from '../data/sqlite-secret-store.js';
import type { ArtifactService } from '../data/store.js';
import { createByteNativeArtifactService } from '../data/store.js';
import { formatHandle } from '../secrets/handle.js';
import {
  CLAIM_LIFETIME_SECONDS,
  CLAIMS_PER_SECRET,
  createSecretService,
  UPLOAD_SLOT_LIFETIME_SECONDS,
} from '../secrets/service.js';
import type { SecretService } from '../secrets/types.js';
import { createMcpServer } from './server.js';

const BASE_URL = 'https://muninn.example';
const SECRET = 'hunter2-staging-db-password';

let dataDir: string;
let artifacts: ArtifactService;
let secrets: SecretService;
let clock: Date;
let client: Client;
let closeServer: () => Promise<void>;
const originalBaseUrl = process.env.MUNINN_PUBLIC_BASE_URL;

function advance(seconds: number): void {
  clock = new Date(clock.getTime() + seconds * 1000);
}

async function connect(withSecrets: SecretService | undefined): Promise<void> {
  const server = createMcpServer(artifacts, withSecrets);
  client = new Client({ name: 'secret-tools-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closeServer = () => server.close();
}

beforeEach(async () => {
  process.env.MUNINN_PUBLIC_BASE_URL = BASE_URL;
  dataDir = await mkdtemp(join(tmpdir(), 'muninn-secret-tools-'));
  const databasePath = join(dataDir, 'artifacts.db');
  artifacts = await createByteNativeArtifactService({
    databasePath,
    filesDir: join(dataDir, 'artifacts'),
  });
  clock = new Date();
  secrets = createSecretService({
    now: () => clock,
    store: await SqliteSecretStore.open(databasePath),
  });
  await connect(secrets);
});

afterEach(async () => {
  await client.close();
  await closeServer();
  await rm(dataDir, { force: true, recursive: true });
  if (originalBaseUrl === undefined) {
    delete process.env.MUNINN_PUBLIC_BASE_URL;
  } else {
    process.env.MUNINN_PUBLIC_BASE_URL = originalBaseUrl;
  }
});

// The tool's text result, and whether it is an error.
async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const result = CallToolResultSchema.parse(await client.callTool({ arguments: args, name }));
  const [first] = result.content;
  if (first?.type !== 'text') {
    throw new Error('expected a text content block');
  }
  return { isError: result.isError === true, text: first.text };
}

const uploadResultSchema = z.strictObject({ expiresAt: z.string(), uploadUrl: z.string() });
const statusResultSchema = z.strictObject({
  id: z.string().optional(),
  status: z.enum(['expired', 'pending', 'read', 'unknown']),
});

async function createUpload(args: Record<string, unknown> = { label: 'Staging DB password' }) {
  const result = await call('create_secret_upload', args);
  expect(result.isError).toBe(false);
  return uploadResultSchema.parse(JSON.parse(result.text));
}

function tokenOf(uploadUrl: string): string {
  const match = new RegExp(`^${BASE_URL}/s/upload/([\\w-]{43})$`, 'u').exec(uploadUrl);
  if (match === null) {
    throw new Error(`not an upload URL: ${uploadUrl}`);
  }
  return match[1]!;
}

async function uploadedSecret(): Promise<{ id: string; key: string }> {
  const { uploadUrl } = await createUpload();
  const created = await secrets.upload(tokenOf(uploadUrl), new TextEncoder().encode(SECRET));
  if (created === null) {
    throw new Error('upload failed');
  }
  return created;
}

async function statusOf(ref: string) {
  const result = await call('secret_status', { ref });
  expect(result.isError).toBe(false);
  expect(result.text).not.toContain(SECRET);
  return statusResultSchema.parse(JSON.parse(result.text));
}

describe('secret tools', () => {
  it('are listed with descriptions that say to pipe the secret with curl and never print it', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const upload = byName.get('create_secret_upload');
    expect(upload?.description).toContain('curl -fsS --data-binary @- "$uploadUrl"');
    expect(upload?.description).toMatch(/never print/iu);
    expect(upload?.description).toContain(
      'If it prints no link, the upload failed: call create_secret_upload again. Do not inspect or echo the input.',
    );
    expect(Object.keys(upload?.inputSchema.properties ?? {}).toSorted()).toEqual([
      'filename',
      'label',
      'ttlSeconds',
    ]);
    expect(byName.get('secret_status')?.description).toBeTruthy();
    expect(Object.keys(byName.get('secret_status')?.inputSchema.properties ?? {})).toEqual(['ref']);

    const claim = byName.get('claim_secret');
    expect(claim?.description).toContain('curl -fsS -X POST "$downloadUrl" | <command');
    expect(claim?.description).toMatch(/never print, echo, or `?cat`?/iu);
    expect(claim?.description).toMatch(/once/iu);
    expect(claim?.description).toMatch(/5 minutes/iu);
    expect(claim?.description).toMatch(/ask the owner for a new secret/iu);
    expect(Object.keys(claim?.inputSchema.properties ?? {})).toEqual(['handle']);
  });

  it('are absent without a secret service', async () => {
    await client.close();
    await closeServer();
    await connect(undefined);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).not.toContain('create_secret_upload');
    expect(tools.map((tool) => tool.name)).not.toContain('secret_status');
    expect(tools.map((tool) => tool.name)).not.toContain('claim_secret');
  });
});

describe('create_secret_upload', () => {
  it('returns only an absolute upload URL and its expiry', async () => {
    const { expiresAt, uploadUrl } = await createUpload({
      filename: 'staging.env',
      label: 'Staging DB password',
      ttlSeconds: 3600,
    });

    expect(tokenOf(uploadUrl)).toHaveLength(43);
    expect(expiresAt).toBe(
      new Date(clock.getTime() + UPLOAD_SLOT_LIFETIME_SECONDS * 1000).toISOString(),
    );
  });

  it('reports invalid input as a tool error with the message', async () => {
    const blank = await call('create_secret_upload', { label: '  ' });
    const badFilename = await call('create_secret_upload', { filename: '../x', label: 'L' });
    const shortTtl = await call('create_secret_upload', { label: 'L', ttlSeconds: 60 });

    expect(blank).toEqual({ isError: true, text: expect.stringMatching(/label/iu) });
    expect(badFilename).toEqual({ isError: true, text: expect.stringMatching(/filename/iu) });
    expect(shortTtl).toEqual({ isError: true, text: expect.stringMatching(/live/iu) });
  });
});

describe('secret_status', () => {
  it('reports a pending secret by id, view link, or handle, never echoing the key', async () => {
    const { id, key } = await uploadedSecret();
    const refs = [id, `${BASE_URL}/s/${id}#${key}`, formatHandle(id, key)];

    const results = await Promise.all(refs.map(async (ref) => call('secret_status', { ref })));

    for (const result of results) {
      expect(result.text).not.toContain(key);
      expect(statusResultSchema.parse(JSON.parse(result.text))).toEqual({ id, status: 'pending' });
    }
  });

  it('reports read, expired, and unknown secrets', async () => {
    const read = await uploadedSecret();
    await secrets.reveal(read.id, read.key);
    const expiring = await uploadedSecret();
    advance(24 * 60 * 60);

    await expect(statusOf(read.id)).resolves.toEqual({ id: read.id, status: 'read' });
    await expect(statusOf(expiring.id)).resolves.toEqual({ id: expiring.id, status: 'expired' });
    await expect(statusOf('AAAAAAAAAAAAAAAAAAAAAA')).resolves.toEqual({
      id: 'AAAAAAAAAAAAAAAAAAAAAA',
      status: 'unknown',
    });
    await expect(statusOf('not a ref')).resolves.toEqual({ status: 'unknown' });
  });

  it('finds the id in every way a reference may be written, never echoing the key', async () => {
    const { id, key } = await uploadedSecret();
    const handle = formatHandle(id, key);
    const link = `${BASE_URL}/s/${id}#${key}`;
    const refs = [
      `  ${id}  `,
      `${id}.`,
      `\`${handle}\``,
      `"${handle}"`,
      `'${handle}'`,
      `handle: ${handle}`,
      `${handle}.`,
      `\`${link}\``,
      `${link}.`,
      `${BASE_URL}/s/${id}%23${key}`,
      `/s/${id}#${key}`,
      `/s/${id}%23${key}`,
      `muninn.example/s/${id}#${key}`,
      `muninn.example/s/${id}%23${key}`,
      `<${link}>`,
    ];

    const results = await Promise.all(refs.map(async (ref) => call('secret_status', { ref })));

    expect(
      results.map((result, index) => [refs[index], result.isError, JSON.parse(result.text)]),
    ).toEqual(refs.map((ref) => [ref, false, { id, status: 'pending' }]));
    for (const result of results) {
      expect(result.text).not.toContain(key);
    }
  });

  it('reports a read secret named by a relative or schemeless link as read', async () => {
    const { id, key } = await uploadedSecret();
    await secrets.reveal(id, key);

    await expect(statusOf(`/s/${id}#${key}`)).resolves.toEqual({ id, status: 'read' });
    await expect(statusOf(`muninn.example/s/${id}#${key}`)).resolves.toEqual({
      id,
      status: 'read',
    });
  });

  it('reports a reference with no secret id as unknown, with no id and no key', async () => {
    const { id, key } = await uploadedSecret();
    const refs = [
      key,
      `#${key}`,
      `sec_.${key}`,
      `sec_${id.slice(1)}.${key}`,
      `${BASE_URL}/s/#${key}`,
      `${BASE_URL}/s/upload/${key}`,
      `not a ref ${key}`,
      // 22 characters, but not a canonical 16-byte id.
      'AAAAAAAAAAAAAAAAAAAAAB',
      `${BASE_URL}/s/AAAAAAAAAAAAAAAAAAAAAB#${key}`,
      '',
    ];

    const results = await Promise.all(refs.map(async (ref) => call('secret_status', { ref })));

    for (const result of results) {
      expect(result.text).not.toContain(key);
      expect(JSON.parse(result.text)).toEqual({ status: 'unknown' });
    }
  });
});

const claimResultSchema = z.strictObject({ downloadUrl: z.string(), expiresAt: z.string() });

function downloadTokenOf(downloadUrl: string): string {
  const match = new RegExp(`^${BASE_URL}/s/download/([\\w-]{43})$`, 'u').exec(downloadUrl);
  if (match === null) {
    throw new Error(`not a download URL: ${downloadUrl}`);
  }
  return match[1]!;
}

async function ownerSecret(content = SECRET): Promise<{ id: string; key: string }> {
  return secrets.create({ content: new TextEncoder().encode(content), label: 'Deploy token' });
}

describe('claim_secret', () => {
  it('returns only a single-use download URL and its expiry, without burning the secret', async () => {
    const { id, key } = await ownerSecret();

    const result = await call('claim_secret', { handle: formatHandle(id, key) });

    expect(result.isError).toBe(false);
    expect(result.text).not.toContain(key);
    expect(result.text).not.toContain(SECRET);
    const { downloadUrl, expiresAt } = claimResultSchema.parse(JSON.parse(result.text));
    expect(expiresAt).toBe(new Date(clock.getTime() + CLAIM_LIFETIME_SECONDS * 1000).toISOString());
    await expect(secrets.status(id)).resolves.toBe('pending');
    const downloaded = await secrets.download(downloadTokenOf(downloadUrl));
    expect(new TextDecoder().decode(downloaded?.content)).toBe(SECRET);
    await expect(secrets.download(downloadTokenOf(downloadUrl))).resolves.toBeNull();
  });

  it('accepts a handle wrapped in whitespace, quotes, backticks, or a sentence', async () => {
    const wraps = [
      (handle: string) => `  ${handle}\n`,
      (handle: string) => `"${handle}"`,
      (handle: string) => `'${handle}'`,
      (handle: string) => `\`${handle}\``,
      (handle: string) => `\`\`\`\n${handle}\n\`\`\``,
      (handle: string) => `handle: ${handle}`,
      (handle: string) => `${handle}.`,
    ];
    // A secret apiece: each has room for only a few unexpired claims.
    const owned = await Promise.all(wraps.map(async () => ownerSecret()));

    const results = await Promise.all(
      wraps.map(async (wrap, index) =>
        call('claim_secret', { handle: wrap(formatHandle(owned[index]!.id, owned[index]!.key)) }),
      ),
    );

    expect(results.map((result) => result.isError)).toEqual(wraps.map(() => false));
    for (const [index, result] of results.entries()) {
      expect(result.text).not.toContain(owned[index]!.key);
      expect(() => claimResultSchema.parse(JSON.parse(result.text))).not.toThrow();
    }
  });

  it('refuses unknown, read, expired, malformed, and wrong-key handles with one message that echoes nothing', async () => {
    const expiring = await ownerSecret();
    advance(24 * 60 * 60 - 1);
    const beforeExpiry = await call('claim_secret', {
      handle: formatHandle(expiring.id, expiring.key),
    });
    expect(beforeExpiry.isError).toBe(false);
    advance(1);
    const read = await ownerSecret();
    await secrets.reveal(read.id, read.key);
    const other = await ownerSecret();
    const pending = await ownerSecret();
    const handles = [
      formatHandle('AAAAAAAAAAAAAAAAAAAAAA', pending.key),
      formatHandle(read.id, read.key),
      formatHandle(expiring.id, expiring.key),
      `sec_${pending.id}.${pending.key.slice(1)}`,
      `sec_${pending.id}.${pending.key}x`,
      // Nothing may extend a handle on either side.
      `x${formatHandle(pending.id, pending.key)}`,
      `${formatHandle(pending.id, pending.key)}A`,
      pending.key,
      `${BASE_URL}/s/${pending.id}#${pending.key}`,
      'not a handle',
      '',
      formatHandle(pending.id, other.key),
    ];

    const results = await Promise.all(
      handles.map(async (handle) => call('claim_secret', { handle })),
    );

    const [first] = results;
    expect(first?.isError).toBe(true);
    for (const [index, result] of results.entries()) {
      expect([handles[index], result]).toEqual([handles[index], first]);
    }
    for (const value of [read, other, expiring, pending]) {
      expect(first?.text).not.toContain(value.key);
      expect(first?.text).not.toContain(value.id);
    }
    expect(first?.text).not.toContain(SECRET);
    const valid = await call('claim_secret', { handle: formatHandle(pending.id, pending.key) });
    expect(valid.isError).toBe(false);
  });

  it('refuses a claim past the per-secret cap with the same message, which says so', async () => {
    const { id, key } = await ownerSecret();
    const handle = formatHandle(id, key);
    const claims = await Promise.all(
      Array.from({ length: CLAIMS_PER_SECRET }, async () => call('claim_secret', { handle })),
    );
    expect(claims.map((claim) => claim.isError)).toEqual(claims.map(() => false));

    const capped = await call('claim_secret', { handle });
    const unknown = await call('claim_secret', { handle: 'not a handle' });

    expect(capped).toEqual(unknown);
    expect(capped.isError).toBe(true);
    expect(capped.text).toMatch(/claimed too many times in the last few minutes/u);
    await expect(secrets.status(id)).resolves.toBe('pending');
    advance(CLAIM_LIFETIME_SECONDS);
    expect((await call('claim_secret', { handle })).isError).toBe(false);
  });

  it('refuses with the same message when the secret service fails, echoing nothing', async () => {
    const { id, key } = await ownerSecret();
    await client.close();
    await closeServer();
    await connect({
      ...secrets,
      claim: async () => {
        throw new Error('store unavailable');
      },
    });
    const logged = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      const failed = await call('claim_secret', { handle: formatHandle(id, key) });
      const unknown = await call('claim_secret', { handle: 'not a handle' });

      expect(failed).toEqual(unknown);
      expect(failed.text).not.toContain(id);
      expect(failed.text).not.toContain(key);
      expect(logged).toHaveBeenCalledOnce();
      const line = logged.mock.calls[0]!.map(String).join(' ');
      expect(line).toContain('store unavailable');
      expect(line).not.toContain(id);
      expect(line).not.toContain(key);
    } finally {
      logged.mockRestore();
    }
  });
});
