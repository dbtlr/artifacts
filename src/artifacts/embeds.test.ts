import { describe, expect, it } from 'vite-plus/test';

import {
  extractEmbedReferences,
  MAX_EMBED_REFERENCES,
  substituteEmbedReferences,
} from './embeds.js';

const BASE = 'https://artifacts.example';

// The ids that extraction finds, in document order.
function idsIn(html: string, base = BASE): string[] {
  return extractEmbedReferences(html, base).map(({ id }) => id);
}

// Stands in for the signer: the path it returns names the id it signed.
const fakeSign = (id: string) => `/a/${id}?expires=9&signature=sig-${id}`;

describe('extractEmbedReferences', () => {
  it('finds root-relative and public-base references in the loading attributes', () => {
    const html = [
      '<img src="/a/img1" alt="x">',
      `<img srcset="${BASE}/a/small 1x, /a/large 2x">`,
      '<picture><source srcset="/a/src1" type="image/webp"><source src="/a/src2"></picture>',
      '<iframe src="/a/frame1"></iframe>',
      '<video src="/a/video1" poster="/a/poster1"></video>',
      '<audio src="/a/audio1"></audio>',
      '<link rel="icon" href="/a/icon1">',
    ].join('\n');

    expect(idsIn(html)).toEqual([
      'img1',
      'small',
      'large',
      'src1',
      'src2',
      'frame1',
      'video1',
      'poster1',
      'audio1',
      'icon1',
    ]);
  });

  it('reads tag and attribute names in any case, and unquoted or single-quoted values', () => {
    const html = `<IMG SRC=/a/unquoted><img src='/a/single'><img\nalt="a > b"\nsrc = "/a/spaced" >`;

    expect(idsIn(html)).toEqual(['unquoted', 'single', 'spaced']);
  });

  it('keeps the author’s host and fragment, and records where each /a/:id path starts', () => {
    const html = `<img src="${BASE}/a/abc#part">`;

    const [reference] = extractEmbedReferences(html, BASE);

    expect(reference).toEqual({ id: 'abc', start: html.indexOf('/a/abc') });
  });

  it('ignores other hosts, other paths, other attributes, and other elements', () => {
    const html = [
      '<img src="https://elsewhere.example/a/foreign">',
      '<img src="//artifacts.example/a/schemeless">',
      '<img src="/a/thumbed/thumb">',
      '<img src="/a/queried?download=1">',
      '<img src="/b/a/nested">',
      '<img data-src="/a/lazy">',
      '<a href="/a/linked">link</a>',
      '<div style="background: url(/a/styled)"></div>',
    ].join('\n');

    expect(idsIn(html)).toEqual([]);
  });

  it('matches a public base URL with a path prefix, and not the host without it', () => {
    expect(idsIn(`<img src="${BASE}/prefix/a/under">`, `${BASE}/prefix`)).toEqual(['under']);
    expect(idsIn(`<img src="${BASE}/a/outside">`, `${BASE}/prefix`)).toEqual([]);
  });

  it('leaves script text, style text, comments, and other raw text alone', () => {
    const html = [
      '<script>const markup = \'<img src="/a/scripted">\';</script>',
      '<style>/* <img src="/a/styled"> */</style>',
      '<!-- <img src="/a/commented"> -->',
      '<textarea><img src="/a/typed"></textarea>',
      '<title><img src="/a/titled"></title>',
      '<img src="/a/real">',
    ].join('\n');

    expect(idsIn(html)).toEqual(['real']);
  });

  // The thumbnail renderer runs without scripts, and then a browser reads
  // <noscript> content as markup and loads its images.
  it('finds references inside noscript, which loads when scripts are off', () => {
    expect(idsIn('<noscript><img src="/a/fallback"></noscript><img src="/a/after">')).toEqual([
      'fallback',
      'after',
    ]);
  });

  it(`keeps only the first ${MAX_EMBED_REFERENCES} references`, () => {
    const html = Array.from(
      { length: MAX_EMBED_REFERENCES + 5 },
      (_, index) => `<img src="/a/id${index}">`,
    ).join('');

    const ids = idsIn(html);

    expect(ids).toHaveLength(MAX_EMBED_REFERENCES);
    expect(ids.at(-1)).toBe(`id${MAX_EMBED_REFERENCES - 1}`);
  });

  it('ends raw text only at an end tag in ASCII case', () => {
    const html = [
      '<SCRIPT>"</scriptx>"; \'<img src="/a/scripted">\'</Script >',
      '<img src="/a/after">',
    ].join('');

    expect(idsIn(html)).toEqual(['after']);
  });

  it('finds nothing in plain text that only looks like a reference', () => {
    expect(idsIn('<p>src="/a/prose"</p>')).toEqual([]);
  });
});

describe('substituteEmbedReferences', () => {
  it('replaces each /a/:id path with a signed path, escaped for an HTML attribute', () => {
    const html = `<img src="${BASE}/a/one#x"><img srcset="/a/two 1x, /a/one 2x">`;

    const result = substituteEmbedReferences(html, extractEmbedReferences(html, BASE), fakeSign);

    expect(result).toBe(
      `<img src="${BASE}/a/one?expires=9&amp;signature=sig-one#x">` +
        '<img srcset="/a/two?expires=9&amp;signature=sig-two 1x, ' +
        '/a/one?expires=9&amp;signature=sig-one 2x">',
    );
  });

  it('signs each distinct artifact once per view', () => {
    const html = '<img src="/a/one"><img src="/a/two"><img src="/a/one">';
    const signed: string[] = [];

    substituteEmbedReferences(html, extractEmbedReferences(html, BASE), (id) => {
      signed.push(id);
      return fakeSign(id);
    });

    expect(signed).toEqual(['one', 'two']);
  });

  it('returns the text unchanged when there are no references', () => {
    expect(substituteEmbedReferences('<p>plain</p>', [], fakeSign)).toBe('<p>plain</p>');
  });

  it('skips a stored reference that does not match the text at its position', () => {
    const html = '<img src="/a/one">';

    const result = substituteEmbedReferences(
      html,
      [
        { id: 'other', start: html.indexOf('/a/one') },
        { id: 'one', start: 0 },
      ],
      fakeSign,
    );

    expect(result).toBe(html);
  });
});
