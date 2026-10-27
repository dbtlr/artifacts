// The decisions behind the one-time secret page (see secret.ts), kept apart
// from the DOM so they can be tested.

const FALLBACK_FILENAME = 'secret.bin';
// A view link's key: 256 bits in unpadded base64url.
const FRAGMENT_KEY = /^#([\w-]{43})$/u;

// How the page offers revealed bytes: as text to copy, or as a file to save.
export type SecretPresentation =
  | { kind: 'text'; text: string }
  | { filename: string; kind: 'file' };

// What a reveal response means for the page: the bytes arrived, the secret
// is gone, or the request failed in a way a retry may fix. Only a successful
// reveal burns the secret, so a retry is safe.
export type RevealOutcome = 'gone' | 'retry' | 'revealed';

// The key in a location's fragment (`location.hash`), or null when the link
// lost it or holds something else.
export function keyFromFragment(hash: string): string | null {
  return FRAGMENT_KEY.exec(hash)?.[1] ?? null;
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// A secret sent with a filename is a file. Without one, it is text when it
// is UTF-8, and otherwise a file named secret.bin.
export function presentSecret(bytes: Uint8Array, filename: string | undefined): SecretPresentation {
  const named = filename === '' ? undefined : filename;
  const text = named === undefined ? decodeText(bytes) : null;
  return text === null
    ? { filename: named ?? FALLBACK_FILENAME, kind: 'file' }
    : { kind: 'text', text };
}

// What Copy puts on the clipboard: the text without the one trailing newline
// that `echo` and most files add, which would break a pasted password.
export function copyText(text: string): string {
  return text.replace(/\r?\n$/u, '');
}

export function classifyReveal(status: number): RevealOutcome {
  if (status === 200) {
    return 'revealed';
  }
  return status === 404 ? 'gone' : 'retry';
}
