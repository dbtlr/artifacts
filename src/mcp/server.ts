import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { ArtifactStore } from '../data/store.js';
import { buildArtifactUrl } from '../urls.js';

const ARTIFACT_TYPE = z.enum(['html', 'md', 'txt']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ text: JSON.stringify(data, null, 2), type: 'text' }] };
}

function toolError(message: string): CallToolResult {
  return { content: [{ text: message, type: 'text' }], isError: true };
}

// A fresh McpServer per request (see src/app.tsx) keeps this factory pure —
// it just wires the five tools to whichever store instance the caller hands
// it, so the same code path serves the default store in production and a
// temp-directory store in tests.
export function createMcpServer(store: ArtifactStore): McpServer {
  const server = new McpServer({ name: 'artifacts', version: '0.1.0' });

  server.registerTool(
    'add_artifact',
    {
      description:
        'Create a new artifact (html, md, or txt) and share it with the user as a persistent URL. ' +
        'Returns the artifact id and a fully-resolved URL — share that URL directly with the user ' +
        'so they can open the document.',
      inputSchema: {
        content: z.string().describe('Full document content'),
        description: z.string().describe('Short description shown in list views'),
        project: z.string().describe('Project name grouping related artifacts'),
        title: z.string().describe('Short title identifying the artifact in list views'),
        type: ARTIFACT_TYPE.describe('Content type: html, md, or txt'),
      },
    },
    (args) => {
      try {
        const artifact = store.createArtifact(args);
        return jsonResult({ ...artifact, url: buildArtifactUrl(artifact.id) });
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  );

  server.registerTool(
    'update_artifact',
    {
      description:
        'Update an existing artifact by id. Any field left unset is unchanged; passing content ' +
        'replaces the full document. Returns the updated metadata and its URL.',
      inputSchema: {
        content: z.string().optional().describe('Replacement content for the full document'),
        description: z.string().optional().describe('New short description'),
        id: z.string().describe('Artifact id, as returned by add_artifact or list_artifacts'),
        project: z.string().optional().describe('New project name'),
        title: z.string().optional().describe('New title'),
        type: ARTIFACT_TYPE.optional().describe('New content type: html, md, or txt'),
      },
    },
    ({ id, ...patch }) => {
      try {
        const updated = store.updateArtifact(id, patch);
        if (!updated) {
          return toolError(`No artifact found with id ${JSON.stringify(id)}`);
        }
        return jsonResult({ ...updated, url: buildArtifactUrl(updated.id) });
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  );

  server.registerTool(
    'remove_artifact',
    {
      description: 'Delete an artifact (both its metadata and its content file) by id.',
      inputSchema: {
        id: z.string().describe('Artifact id to remove'),
      },
    },
    ({ id }) => {
      try {
        const existed = store.removeArtifact(id);
        return jsonResult({ existed, id });
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  );

  server.registerTool(
    'list_artifacts',
    {
      description:
        'List artifact metadata, newest first, optionally filtered by project. Use this to ' +
        'rediscover an artifact you or another agent already created, so you can update it ' +
        'instead of creating a duplicate.',
      inputSchema: {
        project: z.string().optional().describe('Only list artifacts in this project'),
      },
    },
    ({ project }) => {
      try {
        return jsonResult(store.listArtifacts({ project }));
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  );

  server.registerTool(
    'get_artifact',
    {
      description: 'Fetch an artifact by id, including its full content.',
      inputSchema: {
        id: z.string().describe('Artifact id to fetch'),
      },
    },
    ({ id }) => {
      try {
        const artifact = store.getArtifact(id);
        if (!artifact) {
          return toolError(`No artifact found with id ${JSON.stringify(id)}`);
        }
        return jsonResult(artifact);
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  );

  return server;
}
