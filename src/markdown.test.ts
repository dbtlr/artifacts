import { describe, expect, it } from 'vite-plus/test';

import { renderMarkdownToHtml } from './markdown.js';

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
