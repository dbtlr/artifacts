import { describe, expect, it } from 'vite-plus/test';

import { resolveCodeLanguage } from './code-languages.js';

describe('resolveCodeLanguage', () => {
  it('accepts a supported grammar name', () => {
    expect(resolveCodeLanguage('rust')).toBe('rust');
  });

  it('maps a shiki alias to the grammar that defines it', () => {
    expect(resolveCodeLanguage('ts')).toBe('typescript');
    expect(resolveCodeLanguage('sh')).toBe('shellscript');
    expect(resolveCodeLanguage('docker')).toBe('dockerfile');
  });

  it('matches case-insensitively, as shiki does', () => {
    expect(resolveCodeLanguage('TypeScript')).toBe('typescript');
  });

  it('returns undefined for a language outside the supported set', () => {
    expect(resolveCodeLanguage('text')).toBeUndefined();
    expect(resolveCodeLanguage('mermaid')).toBeUndefined();
    expect(resolveCodeLanguage('')).toBeUndefined();
  });

  it('returns undefined for inherited object keys instead of treating them as languages', () => {
    expect(resolveCodeLanguage('constructor')).toBeUndefined();
    expect(resolveCodeLanguage('__proto__')).toBeUndefined();
  });
});
