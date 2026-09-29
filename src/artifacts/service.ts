import { nanoid } from 'nanoid';

import { resolvePublicBaseUrl } from '../urls.js';
import { EMBED_EXTRACTOR_VERSION, extractEmbedReferences } from './embeds.js';
import type { EmbedReference } from './embeds.js';
import { hasValidSignature, isMediaType, MAX_ARTIFACT_BYTES, mediaDefinition } from './media.js';
import type {
  Artifact,
  ArtifactContentStore,
  ArtifactMetadataStore,
  ArtifactService,
  ArtifactWithContent,
  CreateArtifactInput,
  EmbedTemplate,
  MediaType,
} from './types.js';

const ID_LENGTH = 10;
const MAX_ID_ATTEMPTS = 5;
const SAFE_FILENAME = /^[^/\\]+$/u;
const HTML: MediaType = 'text/html';

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function assertValidMediaType(mediaType: MediaType): void {
  if (!isMediaType(mediaType)) {
    throw new Error(`Unsupported artifact media type ${JSON.stringify(mediaType)}`);
  }
}

type BlankableField = 'collection' | 'description' | 'project' | 'title';

function assertNonBlank(field: BlankableField, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Invalid artifact ${field} ${JSON.stringify(value)}: must not be blank`);
  }
}

function assertValidFilename(mediaType: MediaType, filename: string | undefined): void {
  const definition = mediaDefinition(mediaType);
  if (definition.renderingMode === 'binary' && filename === undefined) {
    throw new Error(`Artifact filename is required for ${mediaType}`);
  }
  if (filename === undefined) {
    return;
  }
  if (
    filename !== filename.trim() ||
    filename === '.' ||
    filename === '..' ||
    filename.length > 255 ||
    !SAFE_FILENAME.test(filename) ||
    hasControlCharacter(filename)
  ) {
    throw new Error(
      `Invalid artifact filename ${JSON.stringify(filename)}: must be a safe filename`,
    );
  }
  const dot = filename.lastIndexOf('.');
  const extension = dot < 1 ? '' : filename.slice(dot + 1).toLowerCase();
  if (!definition.filenameExtensions.includes(extension)) {
    throw new Error(
      `Artifact filename ${JSON.stringify(filename)} does not match media type ${mediaType}`,
    );
  }
}

function assertValidContent(mediaType: MediaType, bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(
      `Artifact content is ${String(bytes.byteLength)} bytes; maximum is ${String(MAX_ARTIFACT_BYTES)} bytes`,
    );
  }
  const definition = mediaDefinition(mediaType);
  if (definition.renderingMode === 'binary' && bytes.byteLength === 0) {
    throw new Error('Binary artifact content must not be empty');
  }
  if (!hasValidSignature(mediaType, bytes)) {
    if (definition.renderingMode !== 'binary') {
      throw new Error(`Artifact content is not valid UTF-8 for media type ${mediaType}`);
    }
    throw new Error(`Artifact content signature does not match media type ${mediaType}`);
  }
}

function extractTemplate(bytes: Uint8Array): EmbedTemplate {
  const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return {
    extractorVersion: EMBED_EXTRACTOR_VERSION,
    references: extractEmbedReferences(html, resolvePublicBaseUrl()),
  };
}

// Reports a failed side step that must not change the operation's result.
function reportFailure(step: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    process.stderr.write(`Artifact ${step} failed: ${message}\n`);
  } catch {
    // Reporting must not replace the operation result being preserved.
  }
}

// Artifacts are immutable, so the only writes are create and remove, and
// their order keeps a stored row pointing at stored content: create writes
// content before metadata, and remove drops metadata before content. A get
// that loses a race with a remove therefore finds no row, or finds its
// content already gone once the row is gone too, and resolves null either
// way. Nothing here holds state between calls, so the same rules hold for
// several processes sharing the stores.
//
// An HTML artifact's embed template is extracted once, when it is created,
// and stored beside its metadata, so a view signs its embedded URLs without
// parsing HTML. The template is derived data: a failure to store it never
// fails the create, and a view extracts and stores it again when it is
// missing or was made by another extractor version.
export function createArtifactService(
  metadata: ArtifactMetadataStore,
  content: ArtifactContentStore,
): ArtifactService {
  async function saveTemplate(id: string, template: EmbedTemplate): Promise<void> {
    try {
      await metadata.saveEmbedTemplate(id, template);
    } catch (error) {
      reportFailure('embed template save', error);
    }
  }

  // Stores the artifact under a fresh id; a taken id resolves null. Two
  // creates that draw the same fresh id at once are not guarded against:
  // with ten-character nanoids that is not a practical risk.
  async function storeUnderId(id: string, input: CreateArtifactInput): Promise<Artifact | null> {
    if (await metadata.find(id)) {
      return null;
    }
    const artifact: Artifact = {
      ...(input.collection === undefined ? {} : { collection: input.collection }),
      createdAt: new Date().toISOString(),
      description: input.description,
      ...(input.filename === undefined ? {} : { filename: input.filename }),
      id,
      mediaType: input.mediaType,
      project: input.project,
      title: input.title,
    };

    await content.write(id, input.mediaType, input.content);
    try {
      await metadata.create(artifact);
    } catch (error) {
      try {
        await content.remove(id, input.mediaType);
      } catch (cleanupError) {
        reportFailure('create cleanup', cleanupError);
      }
      throw error;
    }
    return artifact;
  }

  // Tries up to MAX_ID_ATTEMPTS fresh ids, one at a time.
  async function storeNew(input: CreateArtifactInput, attempt = 0): Promise<Artifact> {
    if (attempt >= MAX_ID_ATTEMPTS) {
      throw new Error(
        `Failed to generate a unique artifact id after ${String(MAX_ID_ATTEMPTS)} attempts`,
      );
    }
    const id = nanoid(ID_LENGTH);
    const created = await storeUnderId(id, input);
    return created ?? storeNew(input, attempt + 1);
  }

  async function createArtifact(input: CreateArtifactInput): Promise<Artifact> {
    assertValidMediaType(input.mediaType);
    assertNonBlank('title', input.title);
    assertNonBlank('project', input.project);
    assertNonBlank('description', input.description);
    if (input.collection !== undefined) {
      assertNonBlank('collection', input.collection);
    }
    assertValidFilename(input.mediaType, input.filename);
    assertValidContent(input.mediaType, input.content);
    const template = input.mediaType === HTML ? extractTemplate(input.content) : undefined;
    const created = await storeNew(input);
    if (template !== undefined) {
      await saveTemplate(created.id, template);
    }
    return created;
  }

  // Missing content under a row that still exists is corruption, not a race.
  async function getArtifact(id: string): Promise<ArtifactWithContent | null> {
    const artifact = await metadata.find(id);
    if (artifact === null) {
      return null;
    }
    const bytes = await content.read(id, artifact.mediaType);
    if (bytes !== null) {
      return { ...artifact, content: bytes };
    }
    if ((await metadata.find(id)) === null) {
      return null;
    }
    throw new Error(`Artifact ${JSON.stringify(id)} content is missing`);
  }

  async function getEmbedReferences(id: string): Promise<EmbedReference[] | null> {
    const artifact = await metadata.find(id);
    if (artifact?.mediaType !== HTML) {
      return null;
    }
    const stored = await metadata.findEmbedTemplate(id);
    if (stored?.extractorVersion === EMBED_EXTRACTOR_VERSION) {
      return stored.references;
    }
    const source = await getArtifact(id);
    if (source === null) {
      return null;
    }
    const template = extractTemplate(source.content);
    await saveTemplate(id, template);
    return template.references;
  }

  async function removeArtifact(id: string): Promise<boolean> {
    const artifact = await metadata.find(id);
    if (!artifact || !(await metadata.remove(id))) {
      return false;
    }
    try {
      await content.remove(id, artifact.mediaType);
    } catch (error) {
      reportFailure('remove cleanup', error);
    }
    return true;
  }

  return {
    createArtifact,
    findArtifact: (id) => metadata.find(id),
    getArtifact,
    getEmbedReferences,
    listArtifacts: (query) => metadata.list(query),
    removeArtifact,
  };
}
