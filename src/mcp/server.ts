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
import { buildArtifactUrl } from '../urls.js';

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
  required: boolean,
): Uint8Array | undefined {
  if (content !== undefined && contentBase64 !== undefined) {
    throw new Error('content and contentBase64 are mutually exclusive');
  }
  if (content === undefined && contentBase64 === undefined) {
    if (required) {
      throw new Error('Exactly one of content or contentBase64 is required');
    }
    return undefined;
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

function artifactResult(artifact: Artifact) {
  const legacyType = legacyTypeFromMediaType(artifact.mediaType);
  return {
    ...artifact,
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

export function createMcpServer(service: ArtifactService): McpServer {
  const server = new McpServer({ name: 'artifacts', version: '0.1.0' });

  server.registerTool(
    'add_artifact',
    {
      description:
        'Create a text or binary artifact and return its metadata and resolved URL. Use content ' +
        'for text media and contentBase64 for binary media. Legacy type remains accepted for text.',
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
    (args) => {
      try {
        const mediaType = resolveMediaType(args.mediaType, args.type);
        const content = decodeContent(mediaType, args.content, args.contentBase64, true)!;
        const artifact = service.createArtifact({
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
    'update_artifact',
    {
      description:
        'Update an artifact by id. Unset fields remain unchanged; null clears collection or filename. ' +
        'Use content for text media and contentBase64 for binary media.',
      inputSchema: {
        collection: z.string().nullable().optional().describe('New collection, or null to clear'),
        content: z.string().optional().describe('Replacement UTF-8 content for a text artifact'),
        contentBase64: z
          .string()
          .optional()
          .describe('Replacement canonical base64 binary content'),
        description: z.string().optional().describe('New short description'),
        filename: z.string().nullable().optional().describe('New filename, or null to clear'),
        id: z.string().describe('Artifact id'),
        mediaType: MEDIA_TYPE.optional().describe('New canonical media type'),
        project: z.string().optional().describe('New project name'),
        title: z.string().optional().describe('New title'),
        type: ARTIFACT_TYPE.optional().describe('Legacy new text type: html, md, or txt'),
      },
    },
    ({ id, ...args }) => {
      try {
        const existing = service.findArtifact(id);
        if (!existing) {
          return toolError(`No artifact found with id ${JSON.stringify(id)}`);
        }
        const mediaType =
          args.mediaType === undefined && args.type === undefined
            ? existing.mediaType
            : resolveMediaType(args.mediaType, args.type);
        const content = decodeContent(mediaType, args.content, args.contentBase64, false);
        const updated = service.updateArtifact(id, {
          ...(args.collection === undefined ? {} : { collection: args.collection }),
          ...(content === undefined ? {} : { content }),
          ...(args.description === undefined ? {} : { description: args.description }),
          ...(args.filename === undefined ? {} : { filename: args.filename }),
          ...(args.mediaType === undefined && args.type === undefined ? {} : { mediaType }),
          ...(args.project === undefined ? {} : { project: args.project }),
          ...(args.title === undefined ? {} : { title: args.title }),
        });
        return updated === null
          ? toolError(`No artifact found with id ${JSON.stringify(id)}`)
          : jsonResult(artifactResult(updated));
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
    ({ id }) => {
      try {
        return jsonResult({ existed: service.removeArtifact(id), id });
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
    (query) => {
      try {
        return jsonResult(service.listArtifacts(query).map(artifactResult));
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
    () => {
      try {
        const collections = new Map<string, string>();
        for (const artifact of service.listArtifacts()) {
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
    ({ id, includeContent = false }) => {
      try {
        if (includeContent) {
          const artifact = service.getArtifact(id);
          return artifact === null
            ? toolError(`No artifact found with id ${JSON.stringify(id)}`)
            : jsonResult(artifactWithContentResult(artifact, true));
        }
        const artifact = service.findArtifact(id);
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
