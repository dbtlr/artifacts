import type { Kind } from '../index-view.js';

export const THUMBNAIL_WIDTH = 320;
export const THUMBNAIL_HEIGHT = 200;

type Sketch = { background: string; shapes: string[] };

function rect(x: number, y: number, width: number, height: number, fill: string): string {
  return `<rect x="${String(x)}" y="${String(y)}" width="${String(width)}" height="${String(height)}" fill="${fill}"/>`;
}

// Rows of "text": every third line is shorter, like a paragraph's last line.
function lines(x: number, y: number, width: number, count: number, color: string): string[] {
  return Array.from({ length: count }, (_, index) =>
    rect(x, y + index * 12, index % 3 === 2 ? width * 0.7 : width, 3, color),
  );
}

function sketchFor(kind: Kind): Sketch {
  switch (kind) {
    case 'html': {
      return {
        background: '#101010',
        shapes: [
          rect(26, 20, 110, 10, '#e6e6e6'),
          rect(26, 44, 268, 1, '#333'),
          rect(26, 58, 80, 122, '#2a2a2a'),
          rect(118, 58, 176, 36, '#3a3a3a'),
          rect(118, 102, 176, 36, '#262626'),
          rect(118, 146, 176, 34, '#2e2e2e'),
        ],
      };
    }
    case 'md': {
      return {
        background: '#f7f7f5',
        shapes: [rect(32, 24, 150, 14, '#111'), ...lines(32, 56, 256, 10, '#999')],
      };
    }
    case 'txt': {
      return { background: '#0a0a0a', shapes: lines(32, 56, 256, 10, '#5a5a5a') };
    }
    case 'pdf': {
      return {
        background: '#ffffff',
        shapes: [rect(44, 26, 190, 12, '#111'), ...lines(44, 54, 232, 11, '#bbb')],
      };
    }
    default: {
      // Images: a gradient, since the real preview will be the image itself.
      return {
        background: '#1f3a5f',
        shapes: [
          '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
          '<stop offset="0" stop-color="#1f3a5f"/>',
          '<stop offset="0.6" stop-color="#4a2f6b"/>',
          '<stop offset="1" stop-color="#0a0a0a"/>',
          '</linearGradient></defs>',
          `<rect width="${String(THUMBNAIL_WIDTH)}" height="${String(THUMBNAIL_HEIGHT)}" fill="url(#g)"/>`,
        ],
      };
    }
  }
}

// A drawn stand-in for a preview that does not exist yet (or cannot be
// rendered): a page-shaped sketch tinted per kind, with the kind label in the
// corner so the card still says what the file is. `kind` comes from the media
// registry, never from user input, so no escaping is needed here.
export function placeholderSvg(kind: Kind): string {
  const w = THUMBNAIL_WIDTH;
  const h = THUMBNAIL_HEIGHT;
  const sketch = sketchFor(kind);
  const label = [
    `<rect x="${String(w - 44)}" y="${String(h - 20)}" width="44" height="20" fill="#000" fill-opacity="0.75"/>`,
    `<text x="${String(w - 22)}" y="${String(h - 6)}" text-anchor="middle" font-family="ui-monospace, Menlo, monospace" font-size="10" font-weight="600" fill="#ccc">${kind}</text>`,
  ];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(w)}" height="${String(h)}" viewBox="0 0 ${String(w)} ${String(h)}">`,
    rect(0, 0, w, h, sketch.background),
    ...sketch.shapes,
    ...label,
    '</svg>',
  ].join('');
}
