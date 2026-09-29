// The code languages the browser highlighter (src/client/highlight.ts) has a
// grammar for, shared with the server so markdown.ts links that script only
// when a fence can actually be highlighted. Plain data with no imports: the
// grammars themselves load in the browser, never on the server.
//
// Names are the `@shikijs/langs/<name>` module each grammar loads from.
export const CODE_LANGUAGES = [
  'c',
  'cpp',
  'css',
  'diff',
  'dockerfile',
  'go',
  'html',
  'java',
  'javascript',
  'json',
  'jsonc',
  'jsx',
  'markdown',
  'python',
  'rust',
  'shellscript',
  'sql',
  'toml',
  'tsx',
  'typescript',
  'yaml',
] as const;

export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

// Every other name shiki gives those grammars (each grammar's `name` and
// `aliases`). Shiki knows them only once a grammar has loaded, and the
// grammar to load depends on them. highlight-languages.test.ts checks this
// table against the grammars.
const CODE_LANGUAGE_ALIASES: Record<string, CodeLanguage> = {
  bash: 'shellscript',
  'c++': 'cpp',
  cjs: 'javascript',
  cts: 'typescript',
  docker: 'dockerfile',
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

const SUPPORTED: ReadonlySet<string> = new Set(CODE_LANGUAGES);

function isCodeLanguage(name: string): name is CodeLanguage {
  return SUPPORTED.has(name);
}

// Maps a fence's language name to a supported grammar, case-insensitively as
// shiki does, or undefined when there is no grammar for it. `Object.hasOwn`
// keeps names like `constructor` from matching inherited keys.
export function resolveCodeLanguage(langName: string): CodeLanguage | undefined {
  const requested = langName.toLowerCase();
  if (Object.hasOwn(CODE_LANGUAGE_ALIASES, requested)) {
    return CODE_LANGUAGE_ALIASES[requested];
  }
  return isCodeLanguage(requested) ? requested : undefined;
}
