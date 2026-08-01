import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { createByteNativeArtifactService } from '../data/store.js';
import { MAX_ARTIFACT_BYTES } from './media.js';
import type { ArtifactService, CreateArtifactInput } from './types.js';

let directory: string;
let service: ArtifactService;

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 1]);
const oversizedPng = new Uint8Array(MAX_ARTIFACT_BYTES + 1);
oversizedPng.set(png.subarray(0, 8));

function binaryInput(overrides: Partial<CreateArtifactInput> = {}): CreateArtifactInput {
  return {
    content: png,
    description: 'binary asset',
    filename: 'preview.png',
    mediaType: 'image/png',
    project: 'artifacts',
    title: 'Preview',
    ...overrides,
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'artifacts-binary-'));
  service = await createByteNativeArtifactService({
    databasePath: join(directory, 'artifacts.db'),
    filesDir: join(directory, 'files'),
  });
});

afterEach(async () => rm(directory, { force: true, recursive: true }));

describe('byte-native artifact service', () => {
  it('round-trips arbitrary bytes with canonical metadata and paths', async () => {
    const created = service.createArtifact(binaryInput({ collection: 'ART-12' }));
    const fetched = service.getArtifact(created.id);

    expect(fetched).toMatchObject({
      collection: 'ART-12',
      filename: 'preview.png',
      mediaType: 'image/png',
    });
    expect([...fetched!.content]).toEqual([...png]);
    await expect(readdir(join(directory, 'files'))).resolves.toEqual([`${created.id}.png`]);
  });

  it('filters collections case-insensitively while preserving submitted casing', () => {
    service.createArtifact(binaryInput({ collection: 'ART-12' }));
    service.createArtifact(binaryInput({ collection: 'other', filename: 'other.png' }));

    expect(service.listArtifacts({ collection: 'art-12' })).toHaveLength(1);
    expect(service.listArtifacts({ collection: 'art-12' })[0]?.collection).toBe('ART-12');
  });

  it.each([
    ['missing filename', { filename: undefined }, 'filename is required'],
    ['unsafe filename', { filename: '../preview.png' }, 'safe filename'],
    ['mismatched filename', { filename: 'preview.jpg' }, 'does not match'],
    ['empty bytes', { content: new Uint8Array() }, 'must not be empty'],
    ['bad signature', { content: Uint8Array.from([1, 2, 3]) }, 'signature does not match'],
    ['oversized bytes', { content: oversizedPng }, 'maximum is'],
  ] as const)('rejects %s before durable mutation', async (_name, overrides, message) => {
    expect(() => service.createArtifact(binaryInput(overrides))).toThrow(message);
    expect(service.listArtifacts()).toEqual([]);
    await expect(readdir(join(directory, 'files'))).resolves.toEqual([]);
  });

  it('accepts jpeg aliases but stores the canonical jpg extension', async () => {
    const created = service.createArtifact(
      binaryInput({
        content: Uint8Array.from([255, 216, 255, 219]),
        filename: 'photo.jpeg',
        mediaType: 'image/jpeg',
      }),
    );

    await expect(readdir(join(directory, 'files'))).resolves.toEqual([`${created.id}.jpg`]);
  });

  it('requires valid replacement bytes for a media-type transition', () => {
    const created = service.createArtifact(binaryInput());

    expect(() => service.updateArtifact(created.id, { mediaType: 'application/pdf' })).toThrow(
      'requires replacement content',
    );
    expect(() =>
      service.updateArtifact(created.id, {
        content: new TextEncoder().encode('not a pdf'),
        filename: 'preview.pdf',
        mediaType: 'application/pdf',
      }),
    ).toThrow('signature does not match');
    expect(service.getArtifact(created.id)?.mediaType).toBe('image/png');
  });

  it('accepts common SVG prologues', () => {
    const content = new TextEncoder().encode(
      '<?xml version="1.0"?>\n<!-- generated -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );

    expect(() =>
      service.createArtifact(
        binaryInput({ content, filename: 'diagram.svg', mediaType: 'image/svg+xml' }),
      ),
    ).not.toThrow();
  });

  it.each([
    ['XML lookalike', '<?xmlhack?>\n<svg></svg>'],
    ['unrelated doctype', '<!DOCTYPE html>\n<svg></svg>'],
  ])('rejects an SVG with an %s prologue', (_name, source) => {
    expect(() =>
      service.createArtifact(
        binaryInput({
          content: new TextEncoder().encode(source),
          filename: 'invalid.svg',
          mediaType: 'image/svg+xml',
        }),
      ),
    ).toThrow('signature does not match');
  });

  it('rejects invalid UTF-8 text before durable mutation', () => {
    expect(() =>
      service.createArtifact({
        content: Uint8Array.from([255]),
        description: 'invalid text',
        mediaType: 'text/plain',
        project: 'artifacts',
        title: 'Invalid',
      }),
    ).toThrow('not valid UTF-8');
    expect(service.listArtifacts()).toEqual([]);
  });
});
