import type { HighlighterCore } from 'shiki/core';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

import { loadLanguage, resolveLanguage } from './highlight-languages.js';

// Highlights the page's fenced code blocks in the browser, loaded only on
// pages whose rendered markdown has one (see `hasHighlightableCode` in
// src/markdown.ts). The server emits each block as markdown-it's escaped
// `<pre><code class="language-x">`; this swaps each one it has a grammar for
// with shiki's highlighted `<pre class="shiki">`. Anything else, and every
// block when JavaScript is off (as in thumbnails), stays plain code.
//
// Shiki's JavaScript regex engine instead of its oniguruma wasm engine: no
// wasm file to fetch, and a much smaller download.
//
// Dual light/dark theme: `defaultColor: false` makes shiki emit
// `--shiki-light`/`--shiki-dark` custom properties per token instead of
// baking in one theme's colors, and src/client/styles.css picks the set
// that matches `prefers-color-scheme`.
const THEMES = { dark: 'github-dark', light: 'github-light' };

type CodeBlock = { code: HTMLElement; language: string; pre: HTMLElement };

function findCodeBlocks(): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  for (const code of document.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
    const language = resolveLanguage(code.className);
    const pre = code.parentElement;
    if (language !== undefined && pre !== null) {
      blocks.push({ code, language, pre });
    }
  }
  return blocks;
}

// Loads each distinct grammar once and returns the ones that loaded. A
// grammar that fails (a network error, or one the regex engine rejects)
// leaves only its own blocks plain.
async function loadLanguages(
  highlighter: HighlighterCore,
  languages: Set<string>,
): Promise<Set<string>> {
  const names = [...languages];
  const results = await Promise.allSettled(
    names.map((name) => highlighter.loadLanguage(loadLanguage(name))),
  );
  return new Set(names.filter((_, index) => results[index]?.status === 'fulfilled'));
}

// `textContent` is the decoded source text, and shiki escapes it again in
// its own output, so no artifact text reaches the page as markup.
function highlightBlock(highlighter: HighlighterCore, block: CodeBlock): void {
  const template = document.createElement('template');
  template.innerHTML = highlighter.codeToHtml(block.code.textContent, {
    defaultColor: false,
    lang: block.language,
    themes: THEMES,
  });
  const highlighted = template.content.firstElementChild;
  if (highlighted !== null) {
    block.pre.replaceWith(highlighted);
  }
}

async function highlightPage(): Promise<void> {
  const blocks = findCodeBlocks();
  if (blocks.length === 0) {
    return;
  }
  const highlighter = await createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    langs: [],
    themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark')],
  });
  const loaded = await loadLanguages(highlighter, new Set(blocks.map((block) => block.language)));
  for (const block of blocks) {
    if (!loaded.has(block.language)) {
      continue;
    }
    try {
      highlightBlock(highlighter, block);
    } catch (error) {
      // One block that fails to tokenize stays plain; the rest still highlight.
      console.error(`Could not highlight a ${block.language} block`, error);
    }
  }
}

void highlightPage();
