import MarkdownIt from 'markdown-it';
import type { HighlighterCore } from 'shiki/core';
import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';

// @types/markdown-it exposes the parsed-token shape only via `MarkdownIt`'s
// `export =` namespace merge, which trips over this project's
// `verbatimModuleSyntax`; deriving it from `parse`'s own return type instead
// sidesteps that entirely and stays exactly as accurate.
type Token = ReturnType<InstanceType<typeof MarkdownIt>['parse']>[number];

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

const MERMAID_LANG = 'mermaid';

// A ```mermaid fence is a diagram source, not a language shiki knows how to
// tokenize — it must bypass highlightCode entirely rather than fall into its
// `text` fallback. markdown-it's default fence renderer uses the `highlight`
// callback's return value verbatim whenever it starts with `<pre`, which is
// exactly how shiki's own `codeToHtml` output is threaded through above, so
// this piggybacks on the same seam: return a `<pre class="mermaid">` whose
// body is the raw diagram source, escaped with markdown-it's own
// `utils.escapeHtml` (the same escaping the default renderer would have
// applied) so adversarial source (`<script>`, quotes) can never break out of
// the block. The client-side mermaid entry (src/client/mermaid.ts) finds
// this element by class name and renders it to SVG in the browser.
function renderMermaidFence(code: string): string {
  return `<pre class="mermaid">${markdownIt.utils.escapeHtml(code)}</pre>`;
}

// A fence's language is its `info` string's first whitespace-separated word
// (markdown-it derives the `highlight` callback's `lang` argument the same
// way), so ```mermaid twoslash still counts as mermaid.
function isMermaidFence(token: Token): boolean {
  return token.type === 'fence' && token.info.trim().split(/\s+/u)[0] === MERMAID_LANG;
}

// --- Heading anchors + table of contents ---
//
// Choice: hand-rolled from the token stream rather than a plugin
// (markdown-it-anchor + markdown-it-table-of-contents, or a combined toc
// plugin) — this app needs two small, closely related things (stable slugged
// ids, and a nested list built from the same headings), both a straight walk
// over `md.parse()`'s flat token array covering maybe 30 lines total. Two
// more dependencies (plus their own transitive deps and update cadence) to
// save that little hand-rolled logic isn't a good trade for a KISS codebase
// that already hand-rolls its own slim shiki wiring above.

type HeadingInfo = { id: string; labelHtml: string; level: number };

// Concatenates only the content-bearing descendants of an inline token
// (text, code_inline, etc.), skipping markup tokens like strong_open/_close
// (which carry the `**`/`_` markers as their `.tag`, not their `.content`) —
// the point is plain text for slugging, e.g. "**Bold** _Text_" -> "Bold Text".
function inlineText(token: Token): string {
  if (!token.children) {
    return token.content;
  }
  return token.children.map((child) => inlineText(child)).join('');
}

// Unicode-safe slug: keeps any Unicode letter/number (so headings in, say,
// Cyrillic or CJK still get a legible, non-empty slug) and folds every run of
// anything else (punctuation, whitespace, emoji) to a single hyphen. Prefixed
// with `heading-` so a generated id can never collide with the app's own
// chrome — no element outside artifact content is ever given an id at all,
// but the prefix keeps that true even if one is added later. A heading with
// no letters/numbers at all (e.g. "---" or "😀") falls back to a constant so
// it's still a valid, non-empty id rather than a dangling hyphen.
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return `heading-${slug || 'section'}`;
}

// Repeated headings (two "## Overview" sections, or just two headings that
// slugify to the same text) must not collide on the same id — anchors need
// to be unique to be useful. First occurrence keeps the bare slug; each
// repeat gets a `-1`, `-2`, ... suffix, scoped to one render (a fresh `Map`
// per call, not module state) so concurrent renders of different documents
// never interfere with each other.
function dedupeSlug(slug: string, seen: Map<string, number>): string {
  const count = seen.get(slug) ?? 0;
  seen.set(slug, count + 1);
  return count === 0 ? slug : `${slug}-${String(count)}`;
}

// Walks the parsed token stream once: assigns each heading_open token a
// unique `id` attribute (mutating `tokens` in place, so the default renderer
// picks it up automatically) and returns the ordered heading list the TOC is
// built from. A heading with an empty inline body (`##` alone) still gets an
// id, just with the "section" fallback slug above.
function extractHeadings(tokens: Token[]): HeadingInfo[] {
  const seen = new Map<string, number>();
  const headings: HeadingInfo[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.type !== 'heading_open') {
      continue;
    }
    const inline = tokens[index + 1];
    const text = inline?.type === 'inline' ? inlineText(inline) : '';
    const id = dedupeSlug(slugify(text), seen);
    token.attrSet('id', id);
    const labelHtml =
      inline?.type === 'inline' && inline.children
        ? markdownIt.renderer.renderInline(inline.children, markdownIt.options, {})
        : '';
    const level = Number.parseInt(token.tag.slice(1), 10);
    headings.push({ id, labelHtml, level });
  }
  return headings;
}

type TocNode = { children: TocNode[]; heading: HeadingInfo };

// Standard "stack of open ancestors" tree build: a heading nests under the
// nearest preceding heading of a strictly lower level, however far level
// jumps skip (an h4 straight after an h2 nests under the h2 with no
// intermediate h3), which is the same tolerant behavior markdown-it's own
// toc-plugin ecosystem uses for real-world, not-strictly-sequential headings.
function buildTocTree(headings: HeadingInfo[]): TocNode[] {
  const root: TocNode[] = [];
  const stack: { level: number; node: TocNode }[] = [];
  for (const heading of headings) {
    const node: TocNode = { children: [], heading };
    while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.node.children.push(node);
    } else {
      root.push(node);
    }
    stack.push({ level: heading.level, node });
  }
  return root;
}

function renderTocNodes(nodes: TocNode[]): string {
  if (nodes.length === 0) {
    return '';
  }
  const items = nodes
    .map(
      (node) =>
        `<li><a href="#${node.heading.id}">${node.heading.labelHtml}</a>${renderTocNodes(node.children)}</li>`,
    )
    .join('');
  return `<ol>${items}</ol>`;
}

// Anchor hrefs interpolate `node.heading.id` directly: it's always this
// module's own `slugify` output (`heading-` plus Unicode letters/numbers/
// hyphens only), never adversarial text, so it can't smuggle a quote or
// close the attribute early. `labelHtml` comes from markdown-it's own
// `renderInline`, which already HTML-escapes plain text content the same way
// the heading itself is rendered (see markdown.test.ts's inline-HTML test) —
// safe to interpolate as-is.
function renderToc(headings: HeadingInfo[]): string | undefined {
  // Only documents with 2+ headings get a TOC — a single heading (or none)
  // isn't worth navigating.
  if (headings.length < 2) {
    return undefined;
  }
  return `<nav aria-label="Table of contents" class="toc">${renderTocNodes(buildTocTree(headings))}</nav>`;
}

// markdown-it itself does no I/O and is cheap to construct, so — unlike the
// shiki highlighter above — it doesn't need lazy/async init. Its `highlight`
// callback runs synchronously during `.render()`, so it reads
// `highlighterInstance` directly; `renderMarkdownToHtml` always awaits
// `getHighlighter()` first, guaranteeing that's set by the time render runs.
const markdownIt: MarkdownIt = new MarkdownIt({
  highlight: (code, lang) => {
    if (lang.trim() === MERMAID_LANG) {
      return renderMermaidFence(code);
    }
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

export type RenderedMarkdown = {
  // Whether any ```mermaid fence survived into the render — artifact-page.tsx
  // uses this to decide whether to emit the client-side mermaid <script> tag,
  // so pages without a diagram stay at zero client JS.
  hasMermaid: boolean;
  html: string;
  // A ready-to-inject `<nav>` of nested `<ol>`s, or undefined when the
  // document has fewer than 2 headings (see renderToc above).
  toc: string | undefined;
};

// Converts artifact markdown to an HTML string for server-side rendering,
// alongside the two pieces of document structure the route/page need to
// react to: whether a mermaid diagram is present, and a table of contents.
// Callers inject `html`/`toc` with hono's `raw()` — see artifact-page.tsx —
// since this is the one place in the app that intentionally emits markup
// built from artifact content rather than escaping it.
//
// Renders via `md.parse()` + `md.renderer.render()` (what `md.render()` does
// internally) rather than plain `md.render()`, so the parsed token stream is
// available in between for `extractHeadings` to walk — it mutates heading
// tokens in place (assigning `id` attrs) before the renderer turns them into
// HTML, and the same walk is what produces the TOC and the mermaid flag.
export async function renderMarkdownToHtml(markdown: string): Promise<RenderedMarkdown> {
  await getHighlighter();
  const env = {};
  const tokens = markdownIt.parse(markdown, env);
  const hasMermaid = tokens.some(isMermaidFence);
  const headings = extractHeadings(tokens);
  const html = markdownIt.renderer.render(tokens, markdownIt.options, env);
  return { hasMermaid, html, toc: renderToc(headings) };
}
