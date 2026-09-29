import MarkdownIt from 'markdown-it';

// @types/markdown-it exposes the parsed-token shape only via `MarkdownIt`'s
// `export =` namespace merge, which trips over this project's
// `verbatimModuleSyntax`; deriving it from `parse`'s own return type instead
// sidesteps that entirely and stays exactly as accurate.
type Token = ReturnType<InstanceType<typeof MarkdownIt>['parse']>[number];

const MERMAID_LANG = 'mermaid';

// A ```mermaid fence is a diagram source, not code to highlight.
// markdown-it's default fence renderer uses the `highlight` callback's return
// value verbatim whenever it starts with `<pre`, so the callback below uses
// that seam for mermaid alone: it returns a `<pre class="mermaid">` whose
// body is the raw diagram source, escaped with markdown-it's own
// `utils.escapeHtml` (the same escaping the default renderer would have
// applied) so adversarial source (`<script>`, quotes) can never break out of
// the block. The client-side mermaid entry (src/client/mermaid.ts) finds
// this element by class name and renders it to SVG in the browser.
function renderMermaidFence(code: string): string {
  return `<pre class="mermaid">${markdownIt.utils.escapeHtml(code)}</pre>`;
}

// Single predicate shared by both places that need to recognize "this fence
// is mermaid" — the `highlight` callback below (fed markdown-it's own
// already-derived `langName`) and `isMermaidFence`'s token-stream scan (fed
// the raw `info` string, unescaped the same way markdown-it unescapes it
// before deriving `langName` — see `fenceLangName`). One predicate instead
// of two separate `=== 'mermaid'` checks keeps them from silently drifting
// apart.
function isMermaidLangName(langName: string): boolean {
  return langName === MERMAID_LANG;
}

// Replicates markdown-it's own `langName` derivation (renderer.mjs's `fence`
// rule: `unescapeAll(token.info).trim()`'s first whitespace-separated word)
// so a fence's info string, even one containing an HTML entity or backslash
// escape, is read exactly the way markdown-it itself reads it before calling
// `options.highlight`. Skipping the unescaping here would let a fence like
// "&#109;ermaid" (unescapes to "mermaid") render as `<pre class="mermaid">`
// via the highlight callback below while `hasMermaid` (built from this
// function) stayed false — the two must agree.
function fenceLangName(info: string): string {
  return markdownIt.utils.unescapeAll(info).trim().split(/\s+/u)[0] ?? '';
}

function isMermaidFence(token: Token): boolean {
  return token.type === 'fence' && isMermaidLangName(fenceLangName(token.info));
}

// A fence the browser can highlight: it names a language, and that language
// isn't mermaid. markdown-it tags such a fence `<code class="language-x">`,
// which is what src/client/highlight.ts looks for.
function isHighlightableFence(token: Token): boolean {
  if (token.type !== 'fence') {
    return false;
  }
  const langName = fenceLangName(token.info);
  return langName !== '' && !isMermaidLangName(langName);
}

// --- Heading anchors + table of contents ---
//
// Choice: hand-rolled from the token stream rather than a plugin
// (markdown-it-anchor + markdown-it-table-of-contents, or a combined toc
// plugin) — this app needs two small, closely related things (stable slugged
// ids, and a nested list built from the same headings), both a straight walk
// over `md.parse()`'s flat token array covering maybe 30 lines total. Two
// more dependencies (plus their own transitive deps and update cadence) to
// save that little hand-rolled logic isn't a good trade for a KISS codebase.

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
// repeat gets a `-1`, `-2`, ... suffix. Checked against the *set of ids
// already handed out* (not just a per-base-slug counter) and re-incremented
// until a free one is found, so a suffixed id can never collide with a later
// heading whose own literal text happens to match it — e.g. "Overview",
// "Overview", "Overview 1" yields `heading-overview`, `heading-overview-1`,
// `heading-overview-1-1`, not two headings sharing `heading-overview-1`.
// `usedIds` is a fresh `Set` per render call, not module state, so concurrent
// renders of different documents never interfere with each other.
function dedupeSlug(slug: string, usedIds: Set<string>): string {
  let candidate = slug;
  let suffix = 0;
  while (usedIds.has(candidate)) {
    suffix += 1;
    candidate = `${slug}-${String(suffix)}`;
  }
  usedIds.add(candidate);
  return candidate;
}

// A heading's own rendered HTML is free to contain a real `<a>` (a linked
// heading, e.g. "## [Link Text](url)" is unremarkable markdown) — but the
// TOC wraps every heading's label in its *own* `<a href="#heading-...">`,
// and an `<a>` nested inside an `<a>` is invalid HTML that browsers recover
// from by splitting/closing the outer one early, leaving the section anchor
// empty or non-clickable. Image tokens have the same "this doesn't belong
// nested inside our own anchor" problem for a different reason (no useful
// clickable target). Filtering `link_open`/`link_close`/`image` out of the
// inline token array before rendering keeps every other inline rule (text,
// `strong`, `em`, `code_inline`, ...) intact — including a link's own inner
// text — so the TOC label is plain-but-formatted text inside exactly one
// anchor, never a nested one.
function tocSafeInlineChildren(children: Token[]): Token[] {
  return children.filter(
    (child) => child.type !== 'link_open' && child.type !== 'link_close' && child.type !== 'image',
  );
}

// Walks the parsed token stream once: assigns each heading_open token a
// unique `id` attribute (mutating `tokens` in place, so the default renderer
// picks it up automatically) and returns the ordered heading list the TOC is
// built from. A heading with an empty inline body (`##` alone) still gets an
// id, just with the "section" fallback slug above.
function extractHeadings(tokens: Token[]): HeadingInfo[] {
  const usedIds = new Set<string>();
  const headings: HeadingInfo[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.type !== 'heading_open') {
      continue;
    }
    const inline = tokens[index + 1];
    const text = inline?.type === 'inline' ? inlineText(inline) : '';
    const id = dedupeSlug(slugify(text), usedIds);
    token.attrSet('id', id);
    const labelHtml =
      inline?.type === 'inline' && inline.children
        ? markdownIt.renderer.renderInline(
            tocSafeInlineChildren(inline.children),
            markdownIt.options,
            {},
          )
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

// markdown-it itself does no I/O and is cheap to construct, so it is built
// once at module load. Code is highlighted in the browser, not here: every
// fence but mermaid gets markdown-it's default escaped
// `<pre><code class="language-x">`.
const markdownIt: MarkdownIt = new MarkdownIt({
  // `lang` here is markdown-it's own already-unescaped, already-split
  // `langName` (see fenceLangName's comment) — routed through the same
  // `isMermaidLangName` predicate `isMermaidFence` uses, so this and
  // `hasMermaid` can never disagree about what counts as mermaid. An empty
  // return tells markdown-it to escape and wrap the code itself.
  highlight: (code, lang) => (isMermaidLangName(lang.trim()) ? renderMermaidFence(code) : ''),
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
  // Whether any fence names a language the browser can highlight —
  // artifact-page.tsx emits the client-side highlight <script> only then.
  hasHighlightableCode: boolean;
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
// alongside the document structure the route/page need to react to: whether
// highlightable code or a mermaid diagram is present, and a table of contents.
// Callers inject `html`/`toc` with hono's `raw()` — see artifact-page.tsx —
// since this is the one place in the app that intentionally emits markup
// built from artifact content rather than escaping it.
//
// Renders via `md.parse()` + `md.renderer.render()` (what `md.render()` does
// internally) rather than plain `md.render()`, so the parsed token stream is
// available in between for `extractHeadings` to walk — it mutates heading
// tokens in place (assigning `id` attrs) before the renderer turns them into
// HTML, and the same token stream is what produces the TOC and both flags.
export function renderMarkdownToHtml(markdown: string): RenderedMarkdown {
  const env = {};
  const tokens = markdownIt.parse(markdown, env);
  const hasHighlightableCode = tokens.some(isHighlightableFence);
  const hasMermaid = tokens.some(isMermaidFence);
  const headings = extractHeadings(tokens);
  const html = markdownIt.renderer.render(tokens, markdownIt.options, env);
  return { hasHighlightableCode, hasMermaid, html, toc: renderToc(headings) };
}
