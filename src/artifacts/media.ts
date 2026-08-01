export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

export type MediaType =
  | 'application/pdf'
  | 'image/gif'
  | 'image/jpeg'
  | 'image/png'
  | 'image/svg+xml'
  | 'image/webp'
  | 'text/html'
  | 'text/markdown'
  | 'text/plain';

export type LegacyArtifactType = 'html' | 'md' | 'txt';
export type RenderingMode = 'binary' | 'html' | 'markdown' | 'text';

export type MediaDefinition = {
  extension: string;
  filenameExtensions: readonly string[];
  legacyType?: LegacyArtifactType;
  mediaType: MediaType;
  renderingMode: RenderingMode;
};

export const MEDIA_REGISTRY: Record<MediaType, MediaDefinition> = {
  'application/pdf': {
    extension: 'pdf',
    filenameExtensions: ['pdf'],
    mediaType: 'application/pdf',
    renderingMode: 'binary',
  },
  'image/gif': {
    extension: 'gif',
    filenameExtensions: ['gif'],
    mediaType: 'image/gif',
    renderingMode: 'binary',
  },
  'image/jpeg': {
    extension: 'jpg',
    filenameExtensions: ['jpg', 'jpeg'],
    mediaType: 'image/jpeg',
    renderingMode: 'binary',
  },
  'image/png': {
    extension: 'png',
    filenameExtensions: ['png'],
    mediaType: 'image/png',
    renderingMode: 'binary',
  },
  'image/svg+xml': {
    extension: 'svg',
    filenameExtensions: ['svg'],
    mediaType: 'image/svg+xml',
    renderingMode: 'binary',
  },
  'image/webp': {
    extension: 'webp',
    filenameExtensions: ['webp'],
    mediaType: 'image/webp',
    renderingMode: 'binary',
  },
  'text/html': {
    extension: 'html',
    filenameExtensions: ['html', 'htm'],
    legacyType: 'html',
    mediaType: 'text/html',
    renderingMode: 'html',
  },
  'text/markdown': {
    extension: 'md',
    filenameExtensions: ['md', 'markdown'],
    legacyType: 'md',
    mediaType: 'text/markdown',
    renderingMode: 'markdown',
  },
  'text/plain': {
    extension: 'txt',
    filenameExtensions: ['txt'],
    legacyType: 'txt',
    mediaType: 'text/plain',
    renderingMode: 'text',
  },
};

export function isMediaType(value: string): value is MediaType {
  return Object.hasOwn(MEDIA_REGISTRY, value);
}

export function mediaDefinition(mediaType: MediaType): MediaDefinition {
  return MEDIA_REGISTRY[mediaType];
}

export function mediaTypeFromLegacyType(type: LegacyArtifactType): MediaType {
  switch (type) {
    case 'html': {
      return 'text/html';
    }
    case 'md': {
      return 'text/markdown';
    }
    case 'txt': {
      return 'text/plain';
    }
    default: {
      throw new Error(`Invalid legacy artifact type ${JSON.stringify(type)}`);
    }
  }
}

export function legacyTypeFromMediaType(mediaType: MediaType): LegacyArtifactType | undefined {
  return MEDIA_REGISTRY[mediaType].legacyType;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

export function hasValidSignature(mediaType: MediaType, bytes: Uint8Array): boolean {
  switch (mediaType) {
    case 'image/png': {
      return startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10]);
    }
    case 'image/jpeg': {
      return startsWith(bytes, [255, 216, 255]);
    }
    case 'image/gif': {
      const header = new TextDecoder().decode(bytes.subarray(0, 6));
      return header === 'GIF87a' || header === 'GIF89a';
    }
    case 'image/webp': {
      return (
        new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' &&
        new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP'
      );
    }
    case 'application/pdf': {
      return new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-';
    }
    case 'image/svg+xml': {
      try {
        const source = new TextDecoder('utf-8', { fatal: true })
          .decode(bytes)
          .replace(/^\uFEFF/u, '')
          .trimStart();
        return /^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(source);
      } catch {
        return false;
      }
    }
    default: {
      return true;
    }
  }
}
