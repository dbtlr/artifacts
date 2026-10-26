import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import { SqliteSecretStore } from '../data/sqlite-secret-store.js';
import type { ArtifactService } from '../data/store.js';
import { createByteNativeArtifactService } from '../data/store.js';
import { formatHandle } from '../secrets/handle.js';
import { createSecretService, UPLOAD_SLOT_LIFETIME_SECONDS } from '../secrets/service.js';
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
  });

  it('are absent without a secret service', async () => {
    await client.close();
    await closeServer();
    await connect(undefined);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).not.toContain('create_secret_upload');
    expect(tools.map((tool) => tool.name)).not.toContain('secret_status');
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
      '',
    ];

    const results = await Promise.all(refs.map(async (ref) => call('secret_status', { ref })));

    for (const result of results) {
      expect(result.text).not.toContain(key);
      expect(JSON.parse(result.text)).toEqual({ status: 'unknown' });
    }
  });
});
