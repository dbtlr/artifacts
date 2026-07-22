import MarkdownIt from 'markdown-it';
import type { HighlighterCore } from 'shiki/core';
import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';

// Fine-grained shiki build: `shiki/bundle/full` ships every language and
// theme, and even `shiki/bundle/web` (a curated ~55-language subset) still
// omits things an agent-authored artifact might plausibly contain, like Go,
// Rust, or a Dockerfile. Instead this wires the oniguruma engine plus an
// explicit, short language list via `@shikijs/langs` — shiki's own
// per-language subpackage, already resolved as shiki's transitive
// dependency; declaring it directly just exposes its tree-shakeable
// subpath exports (`@shikijs/langs/<name>`) to this module. Each entry below
// is a dynamic import, so only the languages actually requested at runtime
// are parsed/compiled into the highlighter — not the whole set.
const SHIKI_LANGS = [
  import('@shikijs/langs/c'),
  import('@shikijs/langs/cpp'),
  import('@shikijs/langs/css'),
  import('@shikijs/langs/diff'),
  import('@shikijs/langs/dockerfile'),
  import('@shikijs/langs/go'),
  import('@shikijs/langs/html'),
  import('@shikijs/langs/java'),
  import('@shikijs/langs/javascript'),
  import('@shikijs/langs/json'),
  import('@shikijs/langs/jsonc'),
  import('@shikijs/langs/jsx'),
  import('@shikijs/langs/markdown'),
  import('@shikijs/langs/python'),
  import('@shikijs/langs/rust'),
  import('@shikijs/langs/shellscript'),
  import('@shikijs/langs/sql'),
  import('@shikijs/langs/toml'),
  import('@shikijs/langs/tsx'),
  import('@shikijs/langs/typescript'),
  import('@shikijs/langs/yaml'),
];

// Dual light/dark theme with zero client JS: `codeToHtml` is called below
// with two named themes and `defaultColor: false`, which makes shiki emit
// `--shiki-light`/`--shiki-dark` CSS custom properties per token instead of
// baking in one theme's colors. src/client/styles.css swaps to the dark set
// inside a `@media (prefers-color-scheme: dark)` block — the same query
// Tailwind v4's `dark:` variant already uses by default — so highlighted
// code follows the system color scheme exactly like the rest of this
// zero-client-JS app, with no `<script>` and no `class="dark"` toggle.
const SHIKI_THEMES = { dark: 'github-dark', light: 'github-light' };

let highlighterInstance: HighlighterCore | undefined;
let highlighterPromise: Promise<HighlighterCore> | undefined;

// Lazy singleton (mirrors getDefaultArtifactStore in data/store.ts): building
// the highlighter loads the oniguruma wasm engine plus every grammar/theme
// above, so it must happen exactly once per process, not once per request.
// The in-flight promise itself is memoized so concurrent first requests
// share one build instead of racing separate ones. A failed build clears the
// memoized promise instead of permanently caching the rejection, so a
// transient failure (e.g. a wasm load hiccup) can succeed on the next
// request rather than wedging every future render.
async function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= buildHighlighter();
  try {
    return await highlighterPromise;
  } catch (error) {
    highlighterPromise = undefined;
    throw error;
  }
}

async function buildHighlighter(): Promise<HighlighterCore> {
  const highlighter = await createHighlighterCore({
    engine: createOnigurumaEngine(import('shiki/wasm')),
    langs: SHIKI_LANGS,
    themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark')],
  });
  highlighterInstance = highlighter;
  return highlighter;
}

// Renders one fenced code block to shiki's themed HTML. An unrecognized
// fence language (a typo, or simply a language not in SHIKI_LANGS above)
// makes `codeToHtml` throw rather than return — caught here and retried as
// `text`, shiki's built-in no-grammar-needed passthrough, so one bad fence
// falls back to plain code instead of taking down the whole render.
function highlightCode(highlighter: HighlighterCore, code: string, lang: string): string {
  const requested = lang.trim() || 'text';
  try {
    return highlighter.codeToHtml(code, {
      defaultColor: false,
      lang: requested,
      themes: SHIKI_THEMES,
    });
  } catch {
    return highlighter.codeToHtml(code, {
      defaultColor: false,
      lang: 'text',
      themes: SHIKI_THEMES,
    });
  }
}

// markdown-it itself does no I/O and is cheap to construct, so — unlike the
// shiki highlighter above — it doesn't need lazy/async init. Its `highlight`
// callback runs synchronously during `.render()`, so it reads
// `highlighterInstance` directly; `renderMarkdownToHtml` always awaits
// `getHighlighter()` first, guaranteeing that's set by the time render runs.
const markdownIt: MarkdownIt = new MarkdownIt({
  highlight: (code, lang) => {
    if (!highlighterInstance) {
      throw new Error('renderMarkdownToHtml: highlighter must be loaded before md.render()');
    }
    return highlightCode(highlighterInstance, code, lang);
  },
  // Safety: raw HTML in markdown must never execute on the artifacts domain.
  // `html: false` (markdown-it's own default) escapes any inline HTML tag or
  // comment in the source as literal text instead of passing it through, so
  // there's simply no HTML-in-markdown to sanitize — preferred here over
  // adding a sanitizer dependency (e.g. sanitize-html/DOMPurify) to scrub
  // markup this renderer never emits in the first place: fewer deps, no
  // allow/deny rule-set to keep in sync with new tags or attributes, and no
  // sanitizer-bypass surface for a threat that doesn't exist here. Link
  // hrefs use markdown-it's own default `validateLink`, which already
  // rejects `javascript:`/`vbscript:`/`file:` and non-image `data:` URLs —
  // rejected links fall back to their literal bracket-and-paren text rather
  // than rendering as an (even inert) `<a>`.
  html: false,
  linkify: false,
});

// Converts artifact markdown to an HTML string for server-side rendering.
// Callers inject the result with hono's `raw()` — see artifact-page.tsx —
// since this is the one place in the app that intentionally emits markup
// built from artifact content rather than escaping it.
export async function renderMarkdownToHtml(markdown: string): Promise<string> {
  await getHighlighter();
  return markdownIt.render(markdown);
}
