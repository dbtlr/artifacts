import type { createHighlighterCore } from 'shiki/core';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { renderMarkdownToHtml } from './markdown.js';

// Just enough of shiki/core's shape for the injected-failure mock below —
// avoids a `import type * as` namespace import for one member.
type ShikiCoreModule = { createHighlighterCore: typeof createHighlighterCore };

describe('renderMarkdownToHtml', () => {
  it('renders headings and lists to HTML', async () => {
    const html = await renderMarkdownToHtml('# Title\n\n- one\n- two\n');

    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<li>two</li>');
  });

  it('renders a table', async () => {
    const html = await renderMarkdownToHtml('| a | b |\n| --- | --- |\n| 1 | 2 |\n');

    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  it('highlights a fenced code block with a known language', async () => {
    const html = await renderMarkdownToHtml('```ts\nconst x: number = 1;\n```\n');

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

    const html = await renderMarkdownToHtml('```not-a-real-language\nsome nonsense code\n```\n');

    expect(html).toContain('class="shiki');
    expect(html).toContain('some nonsense code');
  });

  it('neutralizes inline HTML instead of passing it through', async () => {
    const html = await renderMarkdownToHtml('# Hi\n\n<script>alert(1)</script>\n');

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('neutralizes a javascript: link instead of emitting an anchor', async () => {
    const html = await renderMarkdownToHtml('[click me](javascript:alert(1))\n');

    // markdown-it's default link validation rejects the javascript: scheme
    // outright, so the whole link construct fails to parse as a link at all
    // — it falls back to literal (inert) bracket-and-paren text rather than
    // an anchor with a scrubbed href.
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href="javascript:');
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
    await expect(renderWithInjectedFailure('# hi')).resolves.toContain('<h1>hi</h1>');
    expect(buildAttempts).toBe(2);
  });
});
