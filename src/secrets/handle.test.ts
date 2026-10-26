import { describe, expect, it } from 'vite-plus/test';

import { formatHandle, isSecretId, parseHandle } from './handle.js';

const id = 'AAECAwQFBgcICQoLDA0ODw';
const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

describe('secret handles', () => {
  it('formats an id and key and parses them back', () => {
    const handle = formatHandle(id, key);

    expect(handle).toBe(`sec_${id}.${key}`);
    expect(parseHandle(handle)).toEqual({ id, key });
  });

  it.each([
    ['no prefix', `${id}.${key}`],
    ['another prefix', `art_${id}.${key}`],
    ['no separator', `sec_${id}${key}`],
    ['a second separator', `sec_${id}.${key}.extra`],
    ['a short id', `sec_${id.slice(1)}.${key}`],
    ['an id that is not canonical base64url', `sec_${id.slice(0, -1)}x.${key}`],
    ['a long key', `sec_${id}.${key}A`],
    ['a key that is not canonical base64url', `sec_${id}.${key.slice(0, -1)}B`],
    ['a character outside base64url', `sec_${id.slice(1)}+.${key}`],
    ['surrounding whitespace', ` sec_${id}.${key}\n`],
    ['nothing', ''],
  ])('rejects a handle with %s', (_case, handle) => {
    expect(parseHandle(handle)).toBeNull();
  });

  it.each([
    ['a canonical 128-bit id', id, true],
    ['an id that is not canonical base64url', 'AAAAAAAAAAAAAAAAAAAAAB', false],
    ['a short id', id.slice(1), false],
    ['a long id', `${id}A`, false],
    ['an id outside base64url', `${id.slice(1)}+`, false],
  ])('treats %s as a secret id: %s', (_case, value, expected) => {
    expect(isSecretId(value)).toBe(expected);
  });

  it('refuses to format an id or key that is not one', () => {
    expect(() => formatHandle(`${id.slice(1)}.`, key)).toThrow('A secret handle needs');
    expect(() => formatHandle(id, `${key.slice(1)}.`)).toThrow('A secret handle needs');
  });
});
