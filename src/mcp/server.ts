import { Buffer } from 'node:buffer';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  isMediaType,
  legacyTypeFromMediaType,
  mediaDefinition,
  mediaTypeFromLegacyType,
} from '../artifacts/media.js';
import type { Artifact, ArtifactService, ArtifactType, MediaType } from '../artifacts/types.js';
import { parseHandle } from '../secrets/handle.js';
import type { SecretService } from '../secrets/types.js';
import { buildArtifactUrl, buildSecretUploadUrl } from '../urls.js';

const ARTIFACT_TYPE = z.enum(['html', 'md', 'txt']);
const MEDIA_TYPE = z.enum([
  'application/pdf',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
  'text/html',
  'text/markdown',
  'text/plain',
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ text: JSON.stringify(data, null, 2), type: 'text' }] };
}

function toolError(message: string): CallToolResult {
  return { content: [{ text: message, type: 'text' }], isError: true };
}

// Match SQLite NOCASE: collection filtering folds ASCII letters only.
function foldCollectionName(value: string): string {
  return value.replaceAll(/[A-Z]/gu, (character) => character.toLowerCase());
}

function resolveMediaType(
  mediaType: string | undefined,
  type: ArtifactType | undefined,
): MediaType {
  if (mediaType !== undefined) {
    if (!isMediaType(mediaType)) {
      throw new Error(`Unsupported artifact media type ${JSON.stringify(mediaType)}`);
    }
    if (type !== undefined && mediaTypeFromLegacyType(type) !== mediaType) {
      throw new Error('mediaType and legacy type must identify the same text media type');
    }
    return mediaType;
  }
  if (type !== undefined) {
    return mediaTypeFromLegacyType(type);
  }
  throw new Error('Either mediaType or legacy type is required');
}

function decodeBase64(value: string): Uint8Array {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(value)
  ) {
    throw new Error('contentBase64 must be non-empty, canonical base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error('contentBase64 must be non-empty, canonical base64');
  }
  return decoded;
}

function decodeContent(
  mediaType: MediaType,
  content: string | undefined,
  contentBase64: string | undefined,
): Uint8Array {
  if (content !== undefined && contentBase64 !== undefined) {
    throw new Error('content and contentBase64 are mutually exclusive');
  }
  if (content === undefined && contentBase64 === undefined) {
    throw new Error('Exactly one of content or contentBase64 is required');
  }

  const binary = mediaDefinition(mediaType).renderingMode === 'binary';
  if (binary && content !== undefined) {
    throw new Error(`contentBase64 is required for binary media type ${mediaType}`);
  }
  if (!binary && contentBase64 !== undefined) {
    throw new Error(`content is required for text media type ${mediaType}`);
  }
  return content === undefined ? decodeBase64(contentBase64!) : new TextEncoder().encode(content);
}

// Names every field it returns, so the tool output stays this contract even
// when a caller-supplied store hands back objects with extra fields.
function artifactResult(artifact: Artifact) {
  const legacyType = legacyTypeFromMediaType(artifact.mediaType);
  return {
    ...(artifact.collection === undefined ? {} : { collection: artifact.collection }),
    createdAt: artifact.createdAt,
    description: artifact.description,
    ...(artifact.filename === undefined ? {} : { filename: artifact.filename }),
    id: artifact.id,
    mediaType: artifact.mediaType,
    project: artifact.project,
    title: artifact.title,
    ...(legacyType === undefined ? {} : { type: legacyType }),
    url: buildArtifactUrl(artifact.id),
  };
}

function artifactWithContentResult(
  artifact: Artifact & { content: Uint8Array },
  includeContent: boolean,
) {
  const { content, ...metadata } = artifact;
  if (!includeContent) {
    return artifactResult(metadata);
  }
  const binary = mediaDefinition(metadata.mediaType).renderingMode === 'binary';
  return {
    ...artifactResult(metadata),
    ...(binary
      ? { contentBase64: Buffer.from(content).toString('base64') }
      : { content: new TextDecoder('utf-8', { fatal: true }).decode(content) }),
  };
}

const VIEW_LINK_PATH = /^\/s\/([^/]+)$/u;

// The secret id a reference names: a handle's id, a view link's id, or the
// reference itself. The fragment is dropped first, so a key is never echoed.
function secretIdOf(ref: string): string {
  const [withoutFragment = ''] = ref.trim().split('#');
  const handle = parseHandle(withoutFragment);
  if (handle !== null) {
    return handle.id;
  }
  if (URL.canParse(withoutFragment)) {
    const id = VIEW_LINK_PATH.exec(new URL(withoutFragment).pathname)?.[1];
    if (id !== undefined) {
      return id;
    }
  }
  return withoutFragment;
}

const SECRET_UPLOAD_RECIPE =
  '<command that prints the secret> | curl -sS --data-binary @- "$uploadUrl"';

// One-time secret tools (ADR-0008). None accepts or returns secret contents:
// the agent moves the bytes with curl, outside its transcript.
function registerSecretTools(server: McpServer, secrets: SecretService): void {
  server.registerTool(
    'create_secret_upload',
    {
      description:
        'Start sending a one-time secret (a token, password, or key file) to the owner. Returns a ' +
        'single-use uploadUrl that expires in 15 minutes. Never pass the secret to a tool, and ' +
        'never print, echo, or log it: pipe it straight into the upload URL with ' +
        `\`${SECRET_UPLOAD_RECIPE}\`. That command prints only the view link; give the link to ` +
        'the owner, who can reveal the secret once. Use secret_status to see whether it was read.',
      inputSchema: {
        filename: z
          .string()
          .optional()
          .describe('Name to save the secret under, for a file; omit for text'),
        label: z
          .string()
          .describe('What the secret is, shown to the owner, e.g. "Staging DB password"'),
        ttlSeconds: z
          .number()
          .optional()
          .describe('How long the unread secret lives: 3600 to 604800 seconds, default 86400'),
      },
    },
    async ({ filename, label, ttlSeconds }) => {
      try {
        const { expiresAt, uploadToken } = await secrets.createUpload({
          ...(filename === undefined ? {} : { filename }),
          label,
          ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
        });
        return jsonResult({ expiresAt, uploadUrl: buildSecretUploadUrl(uploadToken) });
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  );

  server.registerTool(
    'secret_status',
    {
      description:
        'Report whether a one-time secret is pending, read, expired, or unknown. Never returns ' +
        'its contents.',
      inputSchema: {
        ref: z.string().describe('The secret id, its view link, or its sec_ handle'),
      },
    },
    async ({ ref }) => {
      try {
        const id = secretIdOf(ref);
        return jsonResult({ id, status: await secrets.status(id) });
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  );
}

// The secret tools are registered only when a secret service is supplied.
export function createMcpServer(service: ArtifactService, secrets?: SecretService): McpServer {
  const server = new McpServer({ name: 'muninn', version: '0.1.0' });
  if (secrets !== undefined) {
    registerSecretTools(server, secrets);
  }

  server.registerTool(
    'add_artifact',
    {
      description:
        'Create a text or binary artifact and return its metadata and resolved URL. Use content ' +
        'for text media and contentBase64 for binary media. Legacy type remains accepted for text. ' +
        'Artifacts cannot be changed after creation: publish a revision or variation as a new ' +
        'artifact, usually in the same collection.',
      inputSchema: {
        collection: z
          .string()
          .optional()
          .describe('Optional collection grouping related artifacts'),
        content: z.string().optional().describe('Full UTF-8 content for a text artifact'),
        contentBase64: z
          .string()
          .optional()
          .describe('Canonical base64 content for a binary artifact'),
        description: z.string().describe('Short description shown in list views'),
        filename: z.string().optional().describe('Filename; required for binary artifacts'),
        mediaType: MEDIA_TYPE.optional().describe('Canonical artifact media type'),
        project: z.string().describe('Project name grouping related artifacts'),
        title: z.string().describe('Short title identifying the artifact in list views'),
        type: ARTIFACT_TYPE.optional().describe('Legacy text type: html, md, or txt'),
      },
    },
    async (args) => {
      try {
        const mediaType = resolveMediaType(args.mediaType, args.type);
        const content = decodeContent(mediaType, args.content, args.contentBase64);
        const artifact = await service.createArtifact({
          ...(args.collection === undefined ? {} : { collection: args.collection }),
          content,
          description: args.description,
          ...(args.filename === undefined ? {} : { filename: args.filename }),
          mediaType,
          project: args.project,
          title: args.title,
        });
        return jsonResult(artifactResult(artifact));
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  );

  server.registerTool(
    'remove_artifact',
    {
      description: 'Delete an artifact (both its metadata and content) by id.',
      inputSchema: { id: z.string().describe('Artifact id to remove') },
    },
    async ({ id }) => {
      try {
        return jsonResult({ existed: await service.removeArtifact(id), id });
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  );

  server.registerTool(
    'list_artifacts',
    {
      description: 'List lightweight artifact metadata and resolved URLs, newest first.',
      inputSchema: {
        collection: z.string().optional().describe('Filter by collection, case-insensitively'),
        project: z.string().optional().describe('Filter by project'),
      },
    },
    async (query) => {
      try {
        return jsonResult((await service.listArtifacts(query)).map(artifactResult));
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  );

  server.registerTool(
    'list_collections',
    {
      description: 'List distinct non-empty collection names, preserving their stored casing.',
      inputSchema: {},
    },
    async () => {
      try {
        const collections = new Map<string, string>();
        for (const artifact of await service.listArtifacts()) {
          if (artifact.collection !== undefined) {
            collections.set(foldCollectionName(artifact.collection), artifact.collection);
          }
        }
        return jsonResult([...collections.values()].toSorted((a, b) => a.localeCompare(b)));
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  );

  server.registerTool(
    'get_artifact',
    {
      description:
        'Fetch artifact metadata by id. Set includeContent to true to explicitly retrieve content.',
      inputSchema: {
        id: z.string().describe('Artifact id to fetch'),
        includeContent: z
          .boolean()
          .optional()
          .describe('Include text or base64 content; defaults false'),
      },
    },
    async ({ id, includeContent = false }) => {
      try {
        if (includeContent) {
          const artifact = await service.getArtifact(id);
          return artifact === null
            ? toolError(`No artifact found with id ${JSON.stringify(id)}`)
            : jsonResult(artifactWithContentResult(artifact, true));
        }
        const artifact = await service.findArtifact(id);
        return artifact === null
          ? toolError(`No artifact found with id ${JSON.stringify(id)}`)
          : jsonResult(artifactResult(artifact));
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  );

  return server;
}
