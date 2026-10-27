import { describe, expect, it } from 'vite-plus/test';

import { classifyReveal, copyText, keyFromFragment, presentSecret } from './secret-reveal.js';

const KEY = 'Ab-_0123456789abcdefghijklmnopqrstuvwxyzABC';
const encode = (text: string) => new TextEncoder().encode(text);

describe('keyFromFragment', () => {
  it('reads a 43-character base64url key from the fragment', () => {
    expect(keyFromFragment(`#${KEY}`)).toBe(KEY);
  });

  it('finds no key in a missing, empty, short, long, or foreign fragment', () => {
    for (const hash of ['', '#', `#${KEY.slice(1)}`, `#${KEY}A`, `#${KEY.slice(1)}+`, '#key=x']) {
      expect(keyFromFragment(hash)).toBeNull();
    }
  });
});

describe('presentSecret', () => {
  it('shows a secret with no filename as text when it is UTF-8', () => {
    expect(presentSecret(encode('hunter2 ✓\n'), undefined)).toEqual({
      kind: 'text',
      text: 'hunter2 ✓\n',
    });
  });

  it('offers a secret with a filename as that file, even when it is text', () => {
    expect(presentSecret(encode('A=1\n'), 'staging.env')).toEqual({
      filename: 'staging.env',
      kind: 'file',
    });
  });

  it('offers bytes that are not UTF-8 as secret.bin when there is no filename', () => {
    const bytes = new Uint8Array([255, 254, 0]);

    expect(presentSecret(bytes, undefined)).toEqual({ filename: 'secret.bin', kind: 'file' });
    expect(presentSecret(bytes, '')).toEqual({ filename: 'secret.bin', kind: 'file' });
  });
});

describe('copyText', () => {
  it('drops one trailing newline, either kind, and nothing else', () => {
    expect(copyText('hunter2\n')).toBe('hunter2');
    expect(copyText('hunter2\r\n')).toBe('hunter2');
    expect(copyText('hunter2\n\n')).toBe('hunter2\n');
    expect(copyText('hunter2 ')).toBe('hunter2 ');
    expect(copyText('a\nb')).toBe('a\nb');
    expect(copyText('\n')).toBe('');
  });
});

describe('classifyReveal', () => {
  it('reads 200 as revealed, 404 as gone, and anything else as worth a retry', () => {
    expect(classifyReveal(200)).toBe('revealed');
    expect(classifyReveal(404)).toBe('gone');
    for (const status of [201, 204, 400, 403, 413, 429, 500, 502, 503]) {
      expect(classifyReveal(status)).toBe('retry');
    }
  });
});
