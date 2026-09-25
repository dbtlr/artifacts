import { MEDIA_REGISTRY, mediaDefinition } from './artifacts/media.js';
import type { MediaType } from './artifacts/media.js';
import type { Artifact } from './artifacts/types.js';

// A "kind" is the short file-extension label the gallery shows and filters
// by (html, md, png, ...): the media registry's `extension`, so every media
// type has exactly one kind and the `?kind=` query is human-typable.
export type Kind = string;

export type CountedProject = { count: number; name: string };
export type CountedKind = { count: number; kind: Kind };

export type IndexView = {
  items: Artifact[];
  // The applied kind filter, or undefined when none (or an unknown one) was
  // asked for.
  kind: Kind | undefined;
  // Counts are taken over the unfiltered input so the header links stay stable
  // while a filter is active — the input is already project-scoped on
  // /p/:project, so kind counts there are project-scoped too.
  kinds: CountedKind[];
  projects: CountedProject[];
  total: number;
};

const KNOWN_KINDS = new Set(
  Object.values(MEDIA_REGISTRY).map((definition) => definition.extension),
);

export function kindOf(mediaType: MediaType): Kind {
  return mediaDefinition(mediaType).extension;
}

function countBy<T extends string>(values: T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

// Sorted by count descending, then label ascending, so the busiest project
// or kind leads the header links and ties are deterministic.
function sortedCounts(counts: Map<string, number>): [string, number][] {
  return [...counts.entries()].toSorted(([aName, aCount], [bName, bCount]) =>
    aCount === bCount ? aName.localeCompare(bName) : bCount - aCount,
  );
}

// Pure presentation logic for the home and project galleries. Artifacts are
// few (one trusted user's uploads), so counting and filtering in memory over
// the store's newest-first list is simpler than extra grouped queries.
export function buildIndexView(artifacts: Artifact[], query: { kind?: string }): IndexView {
  const kind = query.kind !== undefined && KNOWN_KINDS.has(query.kind) ? query.kind : undefined;
  return {
    items: kind === undefined ? artifacts : artifacts.filter((a) => kindOf(a.mediaType) === kind),
    kind,
    kinds: sortedCounts(countBy(artifacts.map((a) => kindOf(a.mediaType)))).map(
      ([label, count]) => ({ count, kind: label }),
    ),
    projects: sortedCounts(countBy(artifacts.map((a) => a.project))).map(([name, count]) => ({
      count,
      name,
    })),
    total: artifacts.length,
  };
}
