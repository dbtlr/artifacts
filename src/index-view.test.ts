import { describe, expect, it } from 'vite-plus/test';

import type { Artifact } from './artifacts/types.js';
import { buildIndexView, kindOf } from './index-view.js';

function artifact(overrides: Partial<Artifact> & Pick<Artifact, 'id'>): Artifact {
  return {
    createdAt: '2026-09-24T10:00:00.000Z',
    description: 'd',
    mediaType: 'text/html',
    project: 'p',
    title: 't',
    updatedAt: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

const all: Artifact[] = [
  artifact({ id: '1', mediaType: 'text/html', project: 'scanner' }),
  artifact({ id: '2', mediaType: 'text/markdown', project: 'scanner' }),
  artifact({ filename: 'x.png', id: '3', mediaType: 'image/png', project: 'tooling' }),
  artifact({ id: '4', mediaType: 'text/html', project: 'tooling' }),
  artifact({ id: '5', mediaType: 'text/html', project: 'zeta' }),
];

describe('kindOf', () => {
  it('maps a media type to its short kind label', () => {
    expect(kindOf('text/html')).toBe('html');
    expect(kindOf('text/markdown')).toBe('md');
    expect(kindOf('image/jpeg')).toBe('jpg');
    expect(kindOf('application/pdf')).toBe('pdf');
  });
});

describe('buildIndexView', () => {
  it('counts projects by size then name, and kinds by count', () => {
    const view = buildIndexView(all, {});

    expect(view.total).toBe(5);
    expect(view.items.map((item) => item.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(view.projects).toEqual([
      { count: 2, name: 'scanner' },
      { count: 2, name: 'tooling' },
      { count: 1, name: 'zeta' },
    ]);
    expect(view.kinds).toEqual([
      { count: 3, kind: 'html' },
      { count: 1, kind: 'md' },
      { count: 1, kind: 'png' },
    ]);
  });

  it('filters items by kind while keeping the full kind counts for the filter row', () => {
    const view = buildIndexView(all, { kind: 'html' });

    expect(view.items.map((item) => item.id)).toEqual(['1', '4', '5']);
    expect(view.kind).toBe('html');
    expect(view.kinds.map((entry) => entry.count)).toEqual([3, 1, 1]);
  });

  it('ignores an unknown kind rather than filtering everything out', () => {
    const view = buildIndexView(all, { kind: 'exe' });

    expect(view.kind).toBeUndefined();
    expect(view.items).toHaveLength(5);
  });

  it('scopes kind counts to the given project', () => {
    const view = buildIndexView(
      all.filter((item) => item.project === 'tooling'),
      { kind: 'png' },
    );

    expect(view.items.map((item) => item.id)).toEqual(['3']);
    expect(view.kinds).toEqual([
      { count: 1, kind: 'html' },
      { count: 1, kind: 'png' },
    ]);
  });
});
