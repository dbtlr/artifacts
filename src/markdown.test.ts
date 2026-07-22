import type { createHighlighterCore } from 'shiki/core';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { renderMarkdownToHtml } from './markdown.js';

// Just enough of shiki/core's shape for the injected-failure mock below —
// avoids a `import type * as` namespace import for one member.
type ShikiCoreModule = { createHighlighterCore: typeof createHighlighterCore };

describe('renderMarkdownToHtml', () => {
  it('renders headings and lists to HTML', async () => {
    const { html } = await renderMarkdownToHtml('# Title\n\n- one\n- two\n');

    // Every heading gets an id (see the heading-anchor tests below) — a
    // single heading like this still gets one, even though one heading
    // alone isn't enough to also get a TOC.
    expect(html).toContain('<h1 id="heading-title">Title</h1>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<li>two</li>');
  });

  it('renders a table', async () => {
    const { html } = await renderMarkdownToHtml('| a | b |\n| --- | --- |\n| 1 | 2 |\n');

    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  it('highlights a fenced code block with a known language', async () => {
    const { html } = await renderMarkdownToHtml('```ts\nconst x: number = 1;\n```\n');

    expect(html).toContain('class="shiki');
    expect(html).toContain('<span');
    // Token-level styling proves the grammar loaded, not just the wrapper.
    expect(html).toContain('--shiki-light');
    expect(html).toContain('--shiki-dark');
  });

  it('falls back to plain code for an unrecognized fence language instead of throwing', async () => {
    await expect(
      renderMarkdownToHtml('```not-a-real-language\nsome nonsense code\n```\n'),
    ).resolves.not.toThrow();

    const { html } = await renderMarkdownToHtml(
      '```not-a-real-language\nsome nonsense code\n```\n',
    );

    expect(html).toContain('class="shiki');
    expect(html).toContain('some nonsense code');
  });

  it('neutralizes inline HTML instead of passing it through', async () => {
    const { html } = await renderMarkdownToHtml('# Hi\n\n<script>alert(1)</script>\n');

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('neutralizes a javascript: link instead of emitting an anchor', async () => {
    const { html } = await renderMarkdownToHtml('[click me](javascript:alert(1))\n');

    // markdown-it's default link validation rejects the javascript: scheme
    // outright, so the whole link construct fails to parse as a link at all
    // — it falls back to literal (inert) bracket-and-paren text rather than
    // an anchor with a scrubbed href.
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href="javascript:');
  });
});

describe('mermaid fences', () => {
  it('renders a mermaid fence as a text-escaped <pre class="mermaid"> instead of a shiki block', async () => {
    const { hasMermaid, html } = await renderMarkdownToHtml(
      '```mermaid\nflowchart TD\n  A --> B\n```\n',
    );

    expect(hasMermaid).toBe(true);
    expect(html).toContain('<pre class="mermaid">flowchart TD\n  A --&gt; B\n</pre>');
    expect(html).not.toContain('class="shiki');
  });

  it('escapes adversarial diagram source instead of letting it break out of the <pre>', async () => {
    const { html } = await renderMarkdownToHtml(
      '```mermaid\n</pre><script>alert(1)</script>\n```\n',
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('reports hasMermaid: false and highlights normally when no fence is mermaid', async () => {
    const { hasMermaid, html } = await renderMarkdownToHtml('```ts\nconst x = 1;\n```\n');

    expect(hasMermaid).toBe(false);
    expect(html).toContain('class="shiki');
    expect(html).not.toContain('class="mermaid"');
  });

  it('recognizes an HTML-entity-encoded fence info string the same way markdown-it itself does', async () => {
    // markdown-it's own fence renderer computes the `highlight` callback's
    // `lang` via `utils.unescapeAll(token.info)` before splitting on
    // whitespace, so "&#109;ermaid" (unescapes to "mermaid") already rendered
    // as <pre class="mermaid"> via that callback — but `hasMermaid`, built
    // from a separate token-stream scan, used to read the raw `token.info`
    // without the same unescaping and stayed false. Both must agree.
    const { hasMermaid, html } = await renderMarkdownToHtml(
      '```&#109;ermaid\nflowchart TD\n  A --> B\n```\n',
    );

    expect(hasMermaid).toBe(true);
    expect(html).toContain('<pre class="mermaid">');
    expect(html).not.toContain('class="shiki');
  });
});

describe('heading anchors and table of contents', () => {
  it('slugifies a heading into a stable, prefixed id', async () => {
    const { html } = await renderMarkdownToHtml('## Getting Started\n');

    expect(html).toContain('<h2 id="heading-getting-started">Getting Started</h2>');
  });

  it('dedupes repeated headings with numeric suffixes', async () => {
    const { html, toc } = await renderMarkdownToHtml('## Overview\n\ntext\n\n## Overview\n');

    expect(html).toContain('id="heading-overview"');
    expect(html).toContain('id="heading-overview-1"');
    expect(toc).toContain('href="#heading-overview"');
    expect(toc).toContain('href="#heading-overview-1"');
  });

  it('produces a safe id and an escaped label for adversarial heading text', async () => {
    const { html, toc } = await renderMarkdownToHtml(
      '## <script>alert(1)</script> "quotes\' 日本語 😀\n\n## Second\n',
    );

    // The id is derived only from letters/numbers — no quotes, brackets,
    // whitespace, or the emoji survive into it, so it can never break out of
    // the id/href attribute it's placed in. Asserted as the exact id (not
    // just a pattern the benign "Second" heading would also satisfy).
    expect(html).toContain('<h2 id="heading-script-alert-1-script-quotes-日本語">');
    expect(html).not.toContain('id="heading-<script>');
    // The heading's own rendered text stays escaped, same as any other text.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    // The TOC's label for that heading is escaped the same way.
    expect(toc).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(toc).not.toContain('<script>alert(1)</script>');
  });

  it('keeps unicode letters in the slug instead of dropping them to the fallback', async () => {
    const { html } = await renderMarkdownToHtml('## 日本語\n\n## Second\n');

    expect(html).toContain('id="heading-日本語"');
  });

  it('falls back to a constant slug for a heading with no letters or numbers', async () => {
    const { html } = await renderMarkdownToHtml('## 😀😀😀\n\n## ---\n');

    expect(html).toContain('id="heading-section"');
    // Second heading is just as letter/number-free, so it dedupes off the
    // same fallback rather than colliding with it.
    expect(html).toContain('id="heading-section-1"');
  });

  it('never collides a dedup-suffixed id with a later heading whose literal text matches it', async () => {
    const { html } = await renderMarkdownToHtml(
      '## Overview\n\ntext\n\n## Overview\n\ntext\n\n## Overview 1\n',
    );

    const ids = [...html.matchAll(/id="(heading-[^"]+)"/gu)].map((match) => match[1]);

    expect(ids).toEqual(['heading-overview', 'heading-overview-1', 'heading-overview-1-1']);
    // Every id is unique — the whole point of deduping in the first place.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('omits the TOC for a document with fewer than 2 headings', async () => {
    const zero = await renderMarkdownToHtml('Just a paragraph, no headings.\n');
    const one = await renderMarkdownToHtml('# Only Heading\n\nSome text.\n');

    expect(zero.toc).toBeUndefined();
    expect(one.toc).toBeUndefined();
  });

  it('builds a nested TOC for a document with 2+ headings', async () => {
    const { toc } = await renderMarkdownToHtml(
      '# Title\n\n## Section A\n\n### Subsection\n\n## Section B\n',
    );

    expect(toc).toBeDefined();
    expect(toc).toContain('<nav aria-label="Table of contents" class="toc">');
    expect(toc).toContain('href="#heading-title"');
    expect(toc).toContain('href="#heading-section-a"');
    expect(toc).toContain('href="#heading-subsection"');
    expect(toc).toContain('href="#heading-section-b"');
    // Subsection nests inside Section A's <li>, not as a Section A sibling:
    // its <a> should appear before Section A's own <li> closes.
    const sectionAIndex = toc?.indexOf('href="#heading-section-a"') ?? -1;
    const subsectionIndex = toc?.indexOf('href="#heading-subsection"') ?? -1;
    const sectionBIndex = toc?.indexOf('href="#heading-section-b"') ?? -1;
    expect(sectionAIndex).toBeLessThan(subsectionIndex);
    expect(subsectionIndex).toBeLessThan(sectionBIndex);
  });

  it('flattens a heading containing a link so the TOC never nests an <a> inside its own anchor', async () => {
    const { html, toc } = await renderMarkdownToHtml(
      '## [Link Text](https://example.com)\n\n## Second\n',
    );

    // The heading itself, in the actual content, still renders as a normal
    // link — only the TOC's own copy of the label is flattened.
    expect(html).toContain('<a href="https://example.com">Link Text</a>');
    expect(toc).toBeDefined();
    expect(toc).toContain('href="#heading-link-text"');
    expect(toc).toContain('Link Text');
    // A nested <a href="https://example.com"> inside the TOC's own section
    // anchor is exactly the bug this guards against: browsers recover from
    // nested anchors by splitting/closing the outer one early, leaving the
    // section anchor empty or unclickable.
    expect(toc).not.toContain('href="https://example.com"');
    expect(toc?.match(/<a /gu) ?? []).toHaveLength(2);
  });

  it('drops an image from the TOC label instead of emitting <img>', async () => {
    const { toc } = await renderMarkdownToHtml('## ![alt text](img.png)\n\n## Second\n');

    expect(toc).toBeDefined();
    expect(toc).not.toContain('<img');
  });
});

describe('getHighlighter failure recovery', () => {
  // `vi.doMock` (unlike `vi.mock`) isn't hoisted, so it only affects the
  // dynamic `import('./markdown.js')` below — the static top-level import
  // used by every other test in this file, already resolved before this
  // test runs, is untouched. Undoing the mock and resetting the module
  // registry afterwards keeps that isolation one-directional.
  afterEach(() => {
    vi.doUnmock('shiki/core');
    vi.resetModules();
  });

  it('clears the memoized highlighter promise after a failed build, so the next render retries', async () => {
    let buildAttempts = 0;
    vi.doMock('shiki/core', async (importOriginal) => {
      const actual = await importOriginal<ShikiCoreModule>();
      const createHighlighterCore: typeof actual.createHighlighterCore = (options) => {
        buildAttempts += 1;
        // Fail exactly once — a one-shot injected failure, like a
        // transient wasm-load hiccup — then fall through to the real
        // implementation so the second attempt can actually succeed.
        if (buildAttempts === 1) {
          return Promise.reject(new Error('injected highlighter build failure'));
        }
        return actual.createHighlighterCore(options);
      };
      return { ...actual, createHighlighterCore };
    });
    vi.resetModules();

    const { renderMarkdownToHtml: renderWithInjectedFailure } = await import('./markdown.js');

    await expect(renderWithInjectedFailure('# hi')).rejects.toThrow(
      'injected highlighter build failure',
    );
    // If the failed build's promise were still memoized (the bug this test
    // guards against), this second render would reject again with the same
    // cached error instead of rebuilding and succeeding.
    const { html } = await renderWithInjectedFailure('# hi');
    expect(html).toContain('<h1 id="heading-hi">hi</h1>');
    expect(buildAttempts).toBe(2);
  });
});
