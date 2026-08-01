import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

// A real MCP session, driven end to end: the SDK's own Client, talking real
// streamable-HTTP over a loopback socket, to the same Hono app the packed
// server boots. Bridging the SDK's fetch-based client transport straight to
// `app.request` (no socket) was tried first, but the client transport always
// issues real `fetch()` calls against an absolute URL, so there's no seam to
// intercept without reimplementing part of the transport — booting on an
// ephemeral port (PORT=0 pattern) is the smaller, more honest surface.
import { createApp } from '../app.js';
import type { ArtifactService, ArtifactStore } from '../data/store.js';
import { createArtifactStore, createByteNativeArtifactService } from '../data/store.js';

const artifactSchema = z.object({
  collection: z.string().optional(),
  content: z.string().optional(),
  contentBase64: z.string().optional(),
  createdAt: z.string(),
  description: z.string(),
  filename: z.string().optional(),
  id: z.string(),
  mediaType: z.string(),
  project: z.string(),
  title: z.string(),
  type: z.string().optional(),
  updatedAt: z.string(),
  url: z.string().optional(),
});
const removeResultSchema = z.object({ existed: z.boolean(), id: z.string() });

let dataDir: string;
let store: ArtifactStore;
let mcpService: ArtifactService;
let server: ServerType;
let client: Client;
const originalPublicBaseUrl = process.env.ARTIFACTS_PUBLIC_BASE_URL;

type ToolCallResult = z.infer<typeof CallToolResultSchema>;

function resultText(result: ToolCallResult): string {
  const [first] = result.content;
  if (!first || first.type !== 'text') {
    throw new Error('expected a text content block');
  }
  return first.text;
}

// client.callTool()'s declared return type is a union with a legacy
// toolResult-only shape, which collapses `.content` to `unknown` at the type
// level — parsing through the SDK's own CallToolResultSchema (the shape this
// server actually returns) both narrows that back to the real type and
// double-checks the wire response is well-formed.
async function callToolResult(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const raw = await client.callTool({ arguments: args, name });
  return CallToolResultSchema.parse(raw);
}

async function callTool<T>(
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const result = await callToolResult(name, args);
  if (result.isError) {
    throw new Error(`tool ${name} returned an error: ${resultText(result)}`);
  }
  return schema.parse(JSON.parse(resultText(result)));
}

beforeAll(async () => {
  delete process.env.ARTIFACTS_PUBLIC_BASE_URL;
  dataDir = await mkdtemp(join(tmpdir(), 'artifacts-mcp-'));
  store = await createArtifactStore({
    databasePath: join(dataDir, 'artifacts.db'),
    filesDir: join(dataDir, 'artifacts'),
  });
  mcpService = await createByteNativeArtifactService({
    databasePath: join(dataDir, 'artifacts.db'),
    filesDir: join(dataDir, 'artifacts'),
  });
  const app = createApp(store, mcpService);

  server = serve({ fetch: app.fetch, port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected serve() to bind a network address');
  }
  const baseUrl = new URL(`http://localhost:${String(address.port)}/mcp`);

  client = new Client({ name: 'artifacts-test-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(baseUrl));
});

afterAll(async () => {
  await client.close();
  await promisify(server.close.bind(server))();
  await rm(dataDir, { force: true, recursive: true });
  if (originalPublicBaseUrl === undefined) {
    delete process.env.ARTIFACTS_PUBLIC_BASE_URL;
  } else {
    process.env.ARTIFACTS_PUBLIC_BASE_URL = originalPublicBaseUrl;
  }
});

describe('tools/list', () => {
  it('advertises all six tools with input schemas', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      'add_artifact',
      'get_artifact',
      'list_artifacts',
      'list_collections',
      'remove_artifact',
      'update_artifact',
    ]);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
    }
  });
});

describe('add -> get -> update -> remove', () => {
  it('round-trips an artifact through the full tool surface', async () => {
    const added = await callTool(
      'add_artifact',
      {
        content: '# hello',
        description: 'A round-trip fixture',
        project: 'mcp-tests',
        title: 'Round Trip',
        type: 'md',
      },
      artifactSchema,
    );
    expect(added.id).toHaveLength(10);
    expect(added.url).toBe(`http://localhost:3000/a/${added.id}`);

    expect(added.mediaType).toBe('text/markdown');

    const metadata = await callTool('get_artifact', { id: added.id }, artifactSchema);
    expect(metadata.content).toBeUndefined();

    const fetched = await callTool(
      'get_artifact',
      { id: added.id, includeContent: true },
      artifactSchema,
    );
    expect(fetched.content).toBe('# hello');
    expect(fetched.title).toBe('Round Trip');

    const updated = await callTool(
      'update_artifact',
      { content: '# goodbye', id: added.id, title: 'Round Trip, Updated' },
      artifactSchema,
    );
    expect(updated.title).toBe('Round Trip, Updated');
    expect(updated.project).toBe('mcp-tests');
    expect(updated.url).toBe(added.url);

    const refetched = await callTool(
      'get_artifact',
      { id: added.id, includeContent: true },
      artifactSchema,
    );
    expect(refetched.content).toBe('# goodbye');

    const removed = await callTool('remove_artifact', { id: added.id }, removeResultSchema);
    expect(removed).toEqual({ existed: true, id: added.id });

    const afterRemoval = await callToolResult('get_artifact', { id: added.id });
    expect(afterRemoval.isError).toBe(true);
  });
});

describe('list_artifacts', () => {
  it('lists newest-first and filters by project', async () => {
    const first = await callTool(
      'add_artifact',
      { content: 'a', description: 'first', project: 'list-alpha', title: 'A', type: 'txt' },
      artifactSchema,
    );
    const second = await callTool(
      'add_artifact',
      { content: 'b', description: 'second', project: 'list-beta', title: 'B', type: 'txt' },
      artifactSchema,
    );
    const third = await callTool(
      'add_artifact',
      { content: 'c', description: 'third', project: 'list-alpha', title: 'C', type: 'txt' },
      artifactSchema,
    );

    try {
      const all = await callTool('list_artifacts', {}, z.array(artifactSchema));
      const allIds = all.map((artifact) => artifact.id);
      expect(allIds.indexOf(third.id)).toBeLessThan(allIds.indexOf(second.id));
      expect(allIds.indexOf(second.id)).toBeLessThan(allIds.indexOf(first.id));
      for (const artifact of all) {
        expect(artifact.content).toBeUndefined();
      }

      const filtered = await callTool(
        'list_artifacts',
        { project: 'list-alpha' },
        z.array(artifactSchema),
      );
      expect(filtered.map((artifact) => artifact.id).toSorted()).toEqual(
        [first.id, third.id].toSorted(),
      );
    } finally {
      await callTool('remove_artifact', { id: first.id }, removeResultSchema);
      await callTool('remove_artifact', { id: second.id }, removeResultSchema);
      await callTool('remove_artifact', { id: third.id }, removeResultSchema);
    }
  });
});

describe('binary payloads and collections', () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

  it('round-trips binary content only when explicitly requested', async () => {
    const added = await callTool(
      'add_artifact',
      {
        collection: 'Image Train',
        contentBase64: png.toString('base64'),
        description: 'A tiny PNG fixture',
        filename: 'fixture.png',
        mediaType: 'image/png',
        project: 'mcp-tests',
        title: 'Binary Round Trip',
      },
      artifactSchema,
    );

    try {
      expect(added).toMatchObject({
        collection: 'Image Train',
        filename: 'fixture.png',
        mediaType: 'image/png',
      });
      expect(added.contentBase64).toBeUndefined();

      const metadata = await callTool('get_artifact', { id: added.id }, artifactSchema);
      expect(metadata.contentBase64).toBeUndefined();

      const fetched = await callTool(
        'get_artifact',
        { id: added.id, includeContent: true },
        artifactSchema,
      );
      expect(fetched.contentBase64).toBe(png.toString('base64'));
      expect(fetched.content).toBeUndefined();

      const replacement = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6]);
      const updated = await callTool(
        'update_artifact',
        { contentBase64: replacement.toString('base64'), id: added.id },
        artifactSchema,
      );
      expect(updated.url).toBe(added.url);
      expect(updated.contentBase64).toBeUndefined();

      const refetched = await callTool(
        'get_artifact',
        { id: added.id, includeContent: true },
        artifactSchema,
      );
      expect(refetched.contentBase64).toBe(replacement.toString('base64'));

      const listed = await callTool(
        'list_artifacts',
        { collection: 'image train' },
        z.array(artifactSchema),
      );
      expect(listed.map(({ id }) => id)).toContain(added.id);
      expect(listed.find(({ id }) => id === added.id)?.url).toBe(added.url);

      const collections = await callTool('list_collections', {}, z.array(z.string()));
      expect(collections).toContain('Image Train');
    } finally {
      await callTool('remove_artifact', { id: added.id }, removeResultSchema);
    }
  });

  it('deduplicates collection names with SQLite-compatible ASCII case folding', async () => {
    const collections = ['IMAGES', 'images', 'ÄLBUM', 'älbum'];
    const artifactIds: string[] = [];
    try {
      await collections.reduce(async (previous, collection, index) => {
        await previous;
        const artifact = await callTool(
          'add_artifact',
          {
            collection,
            content: `collection ${String(index)}`,
            description: 'Collection folding fixture',
            mediaType: 'text/plain',
            project: 'mcp-tests',
            title: `Collection ${String(index)}`,
          },
          artifactSchema,
        );
        artifactIds.push(artifact.id);
      }, Promise.resolve());

      const listed = await callTool('list_collections', {}, z.array(z.string()));
      expect(listed.filter((collection) => collection.toLowerCase() === 'images')).toHaveLength(1);
      expect(listed).toContain('ÄLBUM');
      expect(listed).toContain('älbum');
    } finally {
      await Promise.all(
        artifactIds.map((id) => callTool('remove_artifact', { id }, removeResultSchema)),
      );
    }
  });

  it('does not read bytes for metadata-only retrieval', async () => {
    const added = await callTool(
      'add_artifact',
      {
        contentBase64: png.toString('base64'),
        description: 'Content will be removed',
        filename: 'missing.png',
        mediaType: 'image/png',
        project: 'mcp-tests',
        title: 'Metadata Survives',
      },
      artifactSchema,
    );
    await rm(join(dataDir, 'artifacts', `${added.id}.png`));

    const metadata = await callTool('get_artifact', { id: added.id }, artifactSchema);
    expect(metadata.id).toBe(added.id);

    const withContent = await callToolResult('get_artifact', {
      id: added.id,
      includeContent: true,
    });
    expect(withContent.isError).toBe(true);
    await callTool('remove_artifact', { id: added.id }, removeResultSchema);
  });

  it.each([
    ['both payloads', { content: 'x', contentBase64: 'eA==' }, 'mutually exclusive'],
    ['text for binary', { content: 'x' }, 'contentBase64 is required'],
    ['invalid base64', { contentBase64: 'not-base64' }, 'canonical base64'],
    ['noncanonical pad bits', { contentBase64: 'Zh==' }, 'canonical base64'],
  ])('rejects %s', async (_name, payload, message) => {
    const result = await callToolResult('add_artifact', {
      ...payload,
      description: 'd',
      filename: 'fixture.png',
      mediaType: 'image/png',
      project: 'p',
      title: 't',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(message);
  });

  it('rejects base64 payloads for text media', async () => {
    const result = await callToolResult('add_artifact', {
      contentBase64: 'eA==',
      description: 'd',
      mediaType: 'text/plain',
      project: 'p',
      title: 't',
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('content is required');
  });
});

describe('error paths', () => {
  it('reports a clean tool error for an unknown id on get_artifact', async () => {
    const result = await callToolResult('get_artifact', { id: 'unknown-id' });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('unknown-id');
  });

  it('reports a clean tool error for an unknown id on update_artifact', async () => {
    const result = await callToolResult('update_artifact', { id: 'unknown-id', title: 'x' });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('unknown-id');
  });

  it('reports existed: false for remove_artifact on an unknown id, without erroring', async () => {
    const result = await callTool('remove_artifact', { id: 'unknown-id' }, removeResultSchema);

    expect(result).toEqual({ existed: false, id: 'unknown-id' });
  });

  it('rejects an invalid type as a tool error', async () => {
    const result = await callToolResult('add_artifact', {
      content: 'x',
      description: 'd',
      project: 'p',
      title: 't',
      type: 'pdf',
    });

    expect(result.isError).toBe(true);
  });

  it('rejects a blank title with the store validation message', async () => {
    const result = await callToolResult('add_artifact', {
      content: 'x',
      description: 'd',
      project: 'p',
      title: '   ',
      type: 'txt',
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Invalid artifact title');
  });
});

describe('public base url override', () => {
  afterEach(() => {
    delete process.env.ARTIFACTS_PUBLIC_BASE_URL;
  });

  it('builds returned URLs from ARTIFACTS_PUBLIC_BASE_URL, trimming a trailing slash', async () => {
    process.env.ARTIFACTS_PUBLIC_BASE_URL = 'https://artifacts.example/';

    const added = await callTool(
      'add_artifact',
      { content: 'x', description: 'd', project: 'p', title: 't', type: 'txt' },
      artifactSchema,
    );

    expect(added.url).toBe(`https://artifacts.example/a/${added.id}`);

    await callTool('remove_artifact', { id: added.id }, removeResultSchema);
  });
});
