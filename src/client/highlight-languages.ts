import type { LanguageRegistration } from 'shiki/core';

import type { CodeLanguage } from '../code-languages.js';
import { resolveCodeLanguage } from '../code-languages.js';

type LanguageModule = { default: LanguageRegistration[] };

// One dynamic import per supported language, so the build emits only these
// grammars and a page downloads only the ones its own fences use. Keyed by
// CodeLanguage, so the type checker keeps it in step with the shared list.
const LANGUAGE_LOADERS: Record<CodeLanguage, () => Promise<LanguageModule>> = {
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  css: () => import('@shikijs/langs/css'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  go: () => import('@shikijs/langs/go'),
  html: () => import('@shikijs/langs/html'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  jsx: () => import('@shikijs/langs/jsx'),
  markdown: () => import('@shikijs/langs/markdown'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  sql: () => import('@shikijs/langs/sql'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  yaml: () => import('@shikijs/langs/yaml'),
};

const LANGUAGE_CLASS_PREFIX = 'language-';

// Maps a `<code>` element's class (markdown-it emits `language-<fence info>`)
// to a supported grammar, or undefined when there is nothing to load.
export function resolveLanguage(className: string): CodeLanguage | undefined {
  const languageClass = className
    .split(/\s+/u)
    .find((name) => name.startsWith(LANGUAGE_CLASS_PREFIX));
  return languageClass === undefined
    ? undefined
    : resolveCodeLanguage(languageClass.slice(LANGUAGE_CLASS_PREFIX.length));
}

export function loadLanguage(language: CodeLanguage): Promise<LanguageModule> {
  return LANGUAGE_LOADERS[language]();
}
