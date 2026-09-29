import { describe, expect, it } from 'vite-plus/test';

import { resolveLanguage } from './highlight-languages.js';

describe('resolveLanguage', () => {
  it('reads the language from markdown-it’s language- class', () => {
    expect(resolveLanguage('language-rust')).toBe('rust');
  });

  it('maps a shiki alias to the grammar that defines it', () => {
    expect(resolveLanguage('language-ts')).toBe('typescript');
    expect(resolveLanguage('language-sh')).toBe('shellscript');
    expect(resolveLanguage('language-yml')).toBe('yaml');
  });

  it('matches case-insensitively, as shiki does', () => {
    expect(resolveLanguage('language-TypeScript')).toBe('typescript');
  });

  it('returns undefined for a language outside the supported set', () => {
    expect(resolveLanguage('language-not-a-real-language')).toBeUndefined();
  });

  it('returns undefined for inherited object keys instead of treating them as languages', () => {
    expect(resolveLanguage('language-constructor')).toBeUndefined();
    expect(resolveLanguage('language-__proto__')).toBeUndefined();
  });

  it('returns undefined when there is no language class', () => {
    expect(resolveLanguage('')).toBeUndefined();
    expect(resolveLanguage('something-else')).toBeUndefined();
  });
});
