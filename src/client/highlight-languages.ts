import type { LanguageRegistration } from 'shiki/core';

type LanguageLoader = () => Promise<{ default: LanguageRegistration[] }>;

// The languages the browser highlighter knows. A short explicit list, not
// shiki's full bundle, so the build only emits these grammars; each is a
// dynamic import, so a page downloads only the grammars its own fences use.
// Keys are shiki's grammar names.
const LANGUAGE_LOADERS: Record<string, LanguageLoader> = {
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

// Shiki's own aliases for the grammars above (each grammar's `aliases`
// field), needed before the grammar loads to know which one to fetch.
const LANGUAGE_ALIASES: Record<string, string> = {
  bash: 'shellscript',
  'c++': 'cpp',
  cjs: 'javascript',
  cts: 'typescript',
  js: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  py: 'python',
  rs: 'rust',
  sh: 'shellscript',
  shell: 'shellscript',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'shellscript',
};

const LANGUAGE_CLASS_PREFIX = 'language-';

// Maps a `<code>` element's class (markdown-it emits `language-<fence info>`)
// to a supported grammar name, or undefined when there is nothing to load.
// `Object.hasOwn` keeps names like `constructor` from matching inherited keys.
export function resolveLanguage(className: string): string | undefined {
  const languageClass = className
    .split(/\s+/u)
    .find((name) => name.startsWith(LANGUAGE_CLASS_PREFIX));
  if (languageClass === undefined) {
    return undefined;
  }
  const requested = languageClass.slice(LANGUAGE_CLASS_PREFIX.length).toLowerCase();
  const name = Object.hasOwn(LANGUAGE_ALIASES, requested) ? LANGUAGE_ALIASES[requested] : requested;
  return name !== undefined && Object.hasOwn(LANGUAGE_LOADERS, name) ? name : undefined;
}

// Loads the grammar for a name `resolveLanguage` returned.
export function loadLanguage(name: string): Promise<{ default: LanguageRegistration[] }> {
  const loader = LANGUAGE_LOADERS[name];
  if (loader === undefined) {
    return Promise.reject(new Error(`Unsupported language: ${name}`));
  }
  return loader();
}
