import { describe, expect, it } from 'vite-plus/test';

import { CODE_LANGUAGES, resolveCodeLanguage } from '../code-languages.js';
import { loadLanguage, resolveLanguage } from './highlight-languages.js';

describe('resolveLanguage', () => {
  it('reads the language from markdown-it’s language- class', () => {
    expect(resolveLanguage('language-ts')).toBe('typescript');
  });

  it('returns undefined when there is no supported language class', () => {
    expect(resolveLanguage('')).toBeUndefined();
    expect(resolveLanguage('something-else')).toBeUndefined();
    expect(resolveLanguage('language-not-a-real-language')).toBeUndefined();
  });
});

describe('the supported language table', () => {
  // Shiki resolves a grammar's name and aliases only after that grammar
  // loads, so the table in code-languages.ts must list them up front. This
  // keeps it in step with each grammar's own `name` and `aliases`.
  it.each(CODE_LANGUAGES)('resolves every name shiki gives the %s grammar', async (language) => {
    const { default: registrations } = await loadLanguage(language);
    const main = registrations.at(-1);

    expect(main).toBeDefined();
    const names = [main?.name ?? '', ...(main?.aliases ?? [])];
    const resolved = Object.fromEntries(names.map((name) => [name, resolveCodeLanguage(name)]));
    expect(resolved).toEqual(Object.fromEntries(names.map((name) => [name, language])));
  });
});
