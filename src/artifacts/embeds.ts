// An HTML artifact's reference to another artifact of this instance: the
// `/a/<id>` path that starts at `start`, a UTF-16 index into the artifact's
// decoded text. A view replaces exactly that path with a signed one.
export type EmbedReference = { id: string; start: number };

// Bump in any change to what extractEmbedReferences finds: templates stored
// by another version are extracted again when next viewed.
export const EMBED_EXTRACTOR_VERSION = 1;

// The most references one template keeps; later ones stay unsigned. Each
// view signs every distinct artifact its template names, so this bounds a
// view's signing work and the size of the stored template.
export const MAX_EMBED_REFERENCES = 1000;

type UrlAttributeKind = 'srcset' | 'url';

// The attributes whose URLs the browser loads while showing the page. Links,
// script-built URLs, and CSS url() are deliberately not here.
const URL_ATTRIBUTES: Record<string, Record<string, UrlAttributeKind>> = {
  audio: { src: 'url' },
  iframe: { src: 'url' },
  img: { src: 'url', srcset: 'srcset' },
  link: { href: 'url' },
  source: { src: 'url', srcset: 'srcset' },
  video: { poster: 'url', src: 'url' },
};

// HTML names are case-insensitive in ASCII only, so `toLowerCase()`, which
// also folds characters such as the Kelvin sign into `k`, is not used.
function asciiLowerCase(value: string): string {
  return value.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

// A pattern for the end tag of `element` in any ASCII case.
function endTagPattern(element: string): RegExp {
  const letters = element.replaceAll(/[a-z]/gu, (letter) => `[${letter}${letter.toUpperCase()}]`);
  return new RegExp(`</${letters}(?=[\\t\\n\\f\\r />]|$)`, 'gu');
}

// Elements whose content the HTML parser reads as text, not markup, with
// the end tag that closes each. <noscript> is not here: with scripts off, as
// in the thumbnail renderer, its content is markup whose images load.
const RAW_TEXT_END_TAGS = new Map(
  ['iframe', 'noembed', 'noframes', 'script', 'style', 'textarea', 'title', 'xmp'].map(
    (element) => [element, endTagPattern(element)],
  ),
);

// `/a/<id>`, the id in the nanoid alphabet (see data/safe-id.ts).
const REFERENCE_PATH = /^\/a\/([A-Za-z0-9_-]+)(?:#.*)?$/su;

function isSpace(character: string | undefined): boolean {
  return (
    character === ' ' ||
    character === '\t' ||
    character === '\n' ||
    character === '\f' ||
    character === '\r'
  );
}

function isNameEnd(character: string | undefined): boolean {
  return character === undefined || isSpace(character) || character === '/' || character === '>';
}

type Span = { end: number; start: number };

// Scans HTML the way a browser's tokenizer splits it into tags, closely
// enough to find attribute values: comments, doctypes, end tags, and the
// text inside raw-text elements are skipped. Calls `onAttribute` with each
// attribute's lower-cased element and attribute names and its value's span,
// once per name per tag, as the browser keeps only the first. Stops early
// once `isDone` returns true.
function scanAttributes(
  html: string,
  onAttribute: (element: string, name: string, value: Span) => void,
  isDone: () => boolean,
): void {
  let index = 0;
  while (index < html.length && !isDone()) {
    const open = html.indexOf('<', index);
    if (open === -1) {
      return;
    }
    const next = html[open + 1] ?? '';
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      index = close === -1 ? html.length : close + 3;
    } else if (next === '!' || next === '?' || next === '/') {
      const close = html.indexOf('>', open + 2);
      index = close === -1 ? html.length : close + 1;
    } else if (/^[A-Za-z]$/u.test(next)) {
      index = scanTag(html, open + 1, onAttribute);
    } else {
      index = open + 1;
    }
  }
}

// Scans one start tag whose name begins at `nameStart`, and any raw text
// after it. Returns the index where markup resumes.
function scanTag(
  html: string,
  nameStart: number,
  onAttribute: (element: string, name: string, value: Span) => void,
): number {
  let index = nameStart;
  while (!isNameEnd(html[index])) {
    index += 1;
  }
  const element = asciiLowerCase(html.slice(nameStart, index));
  const seen = new Set<string>();
  while (index < html.length) {
    while (isSpace(html[index]) || html[index] === '/') {
      index += 1;
    }
    if (index >= html.length || html[index] === '>') {
      break;
    }
    const attributeStart = index;
    // A name may start with `=`, which then belongs to it.
    index += 1;
    while (!isNameEnd(html[index]) && html[index] !== '=') {
      index += 1;
    }
    const name = asciiLowerCase(html.slice(attributeStart, index));
    while (isSpace(html[index])) {
      index += 1;
    }
    let value: Span | undefined;
    if (html[index] === '=') {
      index += 1;
      while (isSpace(html[index])) {
        index += 1;
      }
      const quote = html[index];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, index + 1);
        const end = close === -1 ? html.length : close;
        value = { end, start: index + 1 };
        index = end + 1;
      } else {
        const start = index;
        while (index < html.length && !isSpace(html[index]) && html[index] !== '>') {
          index += 1;
        }
        value = { end: index, start };
      }
    }
    if (value !== undefined && !seen.has(name)) {
      onAttribute(element, name, value);
    }
    seen.add(name);
  }
  index += 1;
  if (element === 'plaintext') {
    return html.length;
  }
  const endTag = RAW_TEXT_END_TAGS.get(element);
  if (endTag === undefined) {
    return index;
  }
  // Raw text runs to the first matching end tag, whatever it contains.
  endTag.lastIndex = index;
  const close = endTag.exec(html);
  return close === null ? html.length : close.index;
}

// The URL spans in a srcset value: comma-separated candidates, each a URL
// followed by optional descriptors.
function srcsetUrls(html: string, { end, start }: Span): Span[] {
  const urls: Span[] = [];
  let index = start;
  while (index < end) {
    while (index < end && (isSpace(html[index]) || html[index] === ',')) {
      index += 1;
    }
    if (index >= end) {
      break;
    }
    const urlStart = index;
    while (index < end && !isSpace(html[index])) {
      index += 1;
    }
    let urlEnd = index;
    while (urlEnd > urlStart && html[urlEnd - 1] === ',') {
      urlEnd -= 1;
    }
    urls.push({ end: urlEnd, start: urlStart });
    if (urlEnd === index) {
      // Skip the descriptors, up to the next comma outside parentheses.
      let depth = 0;
      while (index < end && (html[index] !== ',' || depth > 0)) {
        if (html[index] === '(') {
          depth += 1;
        } else if (html[index] === ')') {
          depth -= 1;
        }
        index += 1;
      }
    }
  }
  return urls;
}

function trimmed(html: string, { end, start }: Span): Span {
  let from = start;
  let to = end;
  while (from < to && isSpace(html[from])) {
    from += 1;
  }
  while (to > from && isSpace(html[to - 1])) {
    to -= 1;
  }
  return { end: to, start: from };
}

// The reference in the URL at `url`, when it names an artifact of this
// instance: `/a/<id>` from the site root or under `publicBaseUrl`, with at
// most a fragment after it. A query, a sub-path such as `/thumb`, or another
// host is not a reference.
function referenceAt(html: string, url: Span, publicBaseUrl: string): EmbedReference | undefined {
  const text = html.slice(url.start, url.end);
  const pathOffset = text.startsWith(`${publicBaseUrl}/a/`) ? publicBaseUrl.length : 0;
  const id = REFERENCE_PATH.exec(text.slice(pathOffset))?.[1];
  return id === undefined ? undefined : { id, start: url.start + pathOffset };
}

// Finds, in document order, each place where an HTML artifact loads another
// artifact of this instance by URL: the `src`, `srcset`, `poster`, or `href`
// of img, source, iframe, video, audio, and link elements. Runs once, when
// the artifact is stored; the result is its embed template. Keeps at most
// MAX_EMBED_REFERENCES.
export function extractEmbedReferences(html: string, publicBaseUrl: string): EmbedReference[] {
  const references: EmbedReference[] = [];
  const isFull = () => references.length >= MAX_EMBED_REFERENCES;
  scanAttributes(
    html,
    (element, name, value) => {
      const kind = URL_ATTRIBUTES[element]?.[name];
      if (kind === undefined) {
        return;
      }
      const urls = kind === 'srcset' ? srcsetUrls(html, value) : [trimmed(html, value)];
      for (const url of urls) {
        const reference = referenceAt(html, url, publicBaseUrl);
        if (reference !== undefined && !isFull()) {
          references.push(reference);
        }
      }
    },
    isFull,
  );
  return references;
}

// Replaces each referenced `/a/<id>` path with `signedPath(id)`, escaped for
// an attribute value, calling `signedPath` once per distinct id. A reference
// that does not match the text at its position is left alone, so a stale
// template can never corrupt the page.
export async function substituteEmbedReferences(
  html: string,
  references: readonly EmbedReference[],
  signedPath: (id: string) => Promise<string>,
): Promise<string> {
  const matching: EmbedReference[] = [];
  let matchedUpTo = 0;
  for (const reference of references) {
    const path = `/a/${reference.id}`;
    const after = html[reference.start + path.length];
    if (
      reference.start < matchedUpTo ||
      !html.startsWith(path, reference.start) ||
      (after !== undefined && /[A-Za-z0-9_-]/u.test(after))
    ) {
      continue;
    }
    matching.push(reference);
    matchedUpTo = reference.start + path.length;
  }
  const ids = [...new Set(matching.map(({ id }) => id))];
  const paths = await Promise.all(ids.map(async (id) => signedPath(id)));
  const signed = new Map(ids.map((id, index) => [id, paths[index]!.replaceAll('&', '&amp;')]));
  let result = '';
  let copied = 0;
  for (const { id, start } of matching) {
    result += html.slice(copied, start) + signed.get(id)!;
    copied = start + `/a/${id}`.length;
  }
  return result + html.slice(copied);
}
