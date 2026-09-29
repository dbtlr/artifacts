import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vite-plus/test';

import { CODE_LANGUAGES } from './code-languages.js';
import { markdownRenderer, renderMarkdownToHtml } from './markdown.js';

describe('renderMarkdownToHtml', () => {
  it('renders headings and lists to HTML', () => {
    const { html } = renderMarkdownToHtml('# Title\n\n- one\n- two\n');

    // Every heading gets an id (see the heading-anchor tests below) — a
    // single heading like this still gets one, even though one heading
    // alone isn't enough to also get a TOC.
    expect(html).toContain('<h1 id="heading-title">Title</h1>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<li>two</li>');
  });

  it('renders a table', () => {
    const { html } = renderMarkdownToHtml('| a | b |\n| --- | --- |\n| 1 | 2 |\n');

    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  it('emits a fenced code block as plain, escaped code tagged with its language', () => {
    const { hasHighlightableCode, html } = renderMarkdownToHtml('```ts\nconst x = a < b;\n```\n');

    // Highlighting happens in the browser (src/client/highlight.ts), which
    // reads the language from this class.
    expect(hasHighlightableCode).toBe(true);
    expect(html).toContain('<pre><code class="language-ts">const x = a &lt; b;\n</code></pre>');
    expect(html).not.toContain('shiki');
  });

  it('emits a fence with no language as plain code with nothing to highlight', () => {
    const { hasHighlightableCode, html } = renderMarkdownToHtml('```\nplain\n```\n');

    expect(hasHighlightableCode).toBe(false);
    expect(html).toContain('<pre><code>plain\n</code></pre>');
  });

  it('reports no highlightable code for a fence in a language the browser has no grammar for', () => {
    const { hasHighlightableCode } = renderMarkdownToHtml('```text\nplain\n```\n');

    expect(hasHighlightableCode).toBe(false);
  });

  it('reports no highlightable code for a document with only inline code', () => {
    const { hasHighlightableCode } = renderMarkdownToHtml('Some `inline` code.\n');

    expect(hasHighlightableCode).toBe(false);
  });

  it('neutralizes inline HTML instead of passing it through', () => {
    const { html } = renderMarkdownToHtml('# Hi\n\n<script>alert(1)</script>\n');

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('neutralizes a javascript: link instead of emitting an anchor', () => {
    const { html } = renderMarkdownToHtml('[click me](javascript:alert(1))\n');

    // markdown-it's default link validation rejects the javascript: scheme
    // outright, so the whole link construct fails to parse as a link at all
    // — it falls back to literal (inert) bracket-and-paren text rather than
    // an anchor with a scrubbed href.
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href="javascript:');
  });
});

describe('mermaid fences', () => {
  it('renders a mermaid fence as a text-escaped <pre class="mermaid"> instead of a code block', () => {
    const { hasHighlightableCode, hasMermaid, html } = renderMarkdownToHtml(
      '```mermaid\nflowchart TD\n  A --> B\n```\n',
    );

    expect(hasMermaid).toBe(true);
    // A diagram is not code to highlight, so it doesn't pull in the
    // highlighter script on its own.
    expect(hasHighlightableCode).toBe(false);
    expect(html).toContain('<pre class="mermaid">flowchart TD\n  A --&gt; B\n</pre>');
    expect(html).not.toContain('<code');
  });

  it('escapes adversarial diagram source instead of letting it break out of the <pre>', () => {
    const { html } = renderMarkdownToHtml('```mermaid\n</pre><script>alert(1)</script>\n```\n');

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('reports hasMermaid: false when no fence is mermaid', () => {
    const { hasMermaid, html } = renderMarkdownToHtml('```ts\nconst x = 1;\n```\n');

    expect(hasMermaid).toBe(false);
    expect(html).not.toContain('class="mermaid"');
  });

  it('recognizes an HTML-entity-encoded fence info string the same way markdown-it itself does', () => {
    // markdown-it's own fence renderer computes the `highlight` callback's
    // `lang` via `utils.unescapeAll(token.info)` before splitting on
    // whitespace, so "&#109;ermaid" (unescapes to "mermaid") already rendered
    // as <pre class="mermaid"> via that callback — but `hasMermaid`, built
    // from a separate token-stream scan, used to read the raw `token.info`
    // without the same unescaping and stayed false. Both must agree.
    const { hasMermaid, html } = renderMarkdownToHtml(
      '```&#109;ermaid\nflowchart TD\n  A --> B\n```\n',
    );

    expect(hasMermaid).toBe(true);
    expect(html).toContain('<pre class="mermaid">');
    expect(html).not.toContain('<code');
  });
});

describe('heading anchors and table of contents', () => {
  it('slugifies a heading into a stable, prefixed id', () => {
    const { html } = renderMarkdownToHtml('## Getting Started\n');

    expect(html).toContain('<h2 id="heading-getting-started">Getting Started</h2>');
  });

  it('dedupes repeated headings with numeric suffixes', () => {
    const { html, toc } = renderMarkdownToHtml('## Overview\n\ntext\n\n## Overview\n');

    expect(html).toContain('id="heading-overview"');
    expect(html).toContain('id="heading-overview-1"');
    expect(toc).toContain('href="#heading-overview"');
    expect(toc).toContain('href="#heading-overview-1"');
  });

  it('produces a safe id and an escaped label for adversarial heading text', () => {
    const { html, toc } = renderMarkdownToHtml(
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

  it('keeps unicode letters in the slug instead of dropping them to the fallback', () => {
    const { html } = renderMarkdownToHtml('## 日本語\n\n## Second\n');

    expect(html).toContain('id="heading-日本語"');
  });

  it('falls back to a constant slug for a heading with no letters or numbers', () => {
    const { html } = renderMarkdownToHtml('## 😀😀😀\n\n## ---\n');

    expect(html).toContain('id="heading-section"');
    // Second heading is just as letter/number-free, so it dedupes off the
    // same fallback rather than colliding with it.
    expect(html).toContain('id="heading-section-1"');
  });

  it('never collides a dedup-suffixed id with a later heading whose literal text matches it', () => {
    const { html } = renderMarkdownToHtml(
      '## Overview\n\ntext\n\n## Overview\n\ntext\n\n## Overview 1\n',
    );

    const ids = [...html.matchAll(/id="(heading-[^"]+)"/gu)].map((match) => match[1]);

    expect(ids).toEqual(['heading-overview', 'heading-overview-1', 'heading-overview-1-1']);
    // Every id is unique — the whole point of deduping in the first place.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('omits the TOC for a document with fewer than 2 headings', () => {
    const zero = renderMarkdownToHtml('Just a paragraph, no headings.\n');
    const one = renderMarkdownToHtml('# Only Heading\n\nSome text.\n');

    expect(zero.toc).toBeUndefined();
    expect(one.toc).toBeUndefined();
  });

  it('builds a nested TOC for a document with 2+ headings', () => {
    const { toc } = renderMarkdownToHtml(
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

  it('flattens a heading containing a link so the TOC never nests an <a> inside its own anchor', () => {
    const { html, toc } = renderMarkdownToHtml(
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

  it('drops an image from the TOC label instead of emitting <img>', () => {
    const { toc } = renderMarkdownToHtml('## ![alt text](img.png)\n\n## Second\n');

    expect(toc).toBeDefined();
    expect(toc).not.toContain('<img');
  });
});

describe('markdownRenderer.version', () => {
  // A document touching every part of the output: markup, heading ids, the
  // TOC, both flags, and the escaping of unsafe input.
  const SAMPLE = [
    '# Title',
    '',
    '## Section',
    '',
    '## Section',
    '',
    'Text with `code`, <b>html</b>, [a link](https://example.com), and [bad](javascript:alert(1)).',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    '```not-a-language',
    'plain',
    '```',
    '',
    '```mermaid',
    'graph TD; A-->B',
    '```',
    '',
  ].join('\n');

  // Stored renderings are reused until `version` changes, so the version is
  // pinned to a fingerprint of what decides the output: the sample's
  // rendering, the language table in code-languages.ts, and markdown-it's
  // version. When this fails, bump markdownRenderer.version, then update
  // both values below.
  it('is bumped whenever the rendered output can change', () => {
    const markdownItVersion: unknown = createRequire(import.meta.url)(
      'markdown-it/package.json',
    ).version;
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          languages: CODE_LANGUAGES,
          markdownIt: markdownItVersion,
          sample: markdownRenderer.render(SAMPLE),
        }),
      )
      .digest('hex');

    expect({ fingerprint, version: markdownRenderer.version }).toEqual({
      fingerprint: '514d04100cf0019c097c60cde138fa919f21fb5bf453e1454a0a297a8806eb89',
      version: 1,
    });
  });
});
