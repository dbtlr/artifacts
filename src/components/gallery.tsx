import type { FC } from 'hono/jsx';

import type { Artifact } from '../data/store.js';
import { formatDate } from '../format-date.js';
import type { IndexView } from '../index-view.js';
import { kindOf } from '../index-view.js';
import { THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH } from '../thumbnails/placeholder.js';

export function projectHref(project: string): string {
  return `/p/${encodeURIComponent(project)}`;
}

const filterLink = 'flex items-baseline gap-1 hover:text-stone-900 dark:hover:text-white';
const filterLinkOn = 'flex items-baseline gap-1 text-stone-900 dark:text-white';
const filterCount = 'text-xs text-stone-400 tabular-nums dark:text-stone-600';

type FilterRowProps = {
  // Where the kind links point: `/` on the home page, `/p/:project` on a
  // project page, so a kind filter stays inside the project.
  basePath: string;
  view: IndexView;
};

// Two filter rows in one line: projects on the left (home page only, since a
// project page is already scoped), kinds on the right. Every link is a plain
// server-rendered anchor; the active one is simply brighter.
export const GalleryFilters: FC<FilterRowProps> = ({ basePath, view }) => (
  <nav class="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-stone-200 py-2 text-sm text-stone-500 dark:border-stone-800 dark:text-stone-400">
    {basePath === '/' && (
      <>
        <a href="/" class={view.kind === undefined ? filterLinkOn : filterLink}>
          <span>All</span>
          <span class={filterCount}>{view.total}</span>
        </a>
        {view.projects.map((project) => (
          <a key={project.name} href={projectHref(project.name)} class={filterLink}>
            <span>{project.name}</span>
            <span class={filterCount}>{project.count}</span>
          </a>
        ))}
      </>
    )}
    <span class="ml-auto" />
    <a href={basePath} class={view.kind === undefined ? filterLinkOn : filterLink}>
      <span>any kind</span>
    </a>
    {view.kinds.map((entry) => (
      <a
        key={entry.kind}
        href={`${basePath}?kind=${entry.kind}`}
        class={view.kind === entry.kind ? filterLinkOn : filterLink}
      >
        <span>{entry.kind}</span>
        <span class={filterCount}>{entry.count}</span>
      </a>
    ))}
  </nav>
);

type GalleryProps = { artifacts: Artifact[]; emptyMessage: string };

// The card grid shared by the home page and /p/:project. The store already
// returns newest-first; this renders order as given. The thumbnail is always
// an <img> pointing at /a/:id/thumb, which answers with a drawn placeholder
// until a rendered preview exists, so the markup never has to know which.
export const ArtifactGallery: FC<GalleryProps> = ({ artifacts, emptyMessage }) => {
  if (artifacts.length === 0) {
    return <p class="mt-8 text-stone-600 dark:text-stone-400">{emptyMessage}</p>;
  }

  return (
    <ul class="mt-5 grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
      {artifacts.map((artifact) => (
        <li key={artifact.id}>
          <a href={`/a/${artifact.id}`} class="group block">
            <img
              src={`/a/${artifact.id}/thumb`}
              alt=""
              loading="lazy"
              width={THUMBNAIL_WIDTH}
              height={THUMBNAIL_HEIGHT}
              class="aspect-[16/10] w-full border border-stone-200 bg-stone-100 object-cover object-top dark:border-stone-800 dark:bg-stone-900"
            />
            <span class="mt-2 block font-semibold leading-snug text-stone-900 group-hover:underline dark:text-stone-100">
              {artifact.title}
            </span>
          </a>
          <p class="mt-1 flex flex-wrap gap-x-2 text-xs text-stone-500 dark:text-stone-400">
            <a
              href={projectHref(artifact.project)}
              class="text-amber-700 hover:underline dark:text-amber-500"
            >
              {artifact.project}
            </a>
            <span class="font-mono">{kindOf(artifact.mediaType)}</span>
            <span class="tabular-nums">{formatDate(artifact.createdAt, 'short')}</span>
            {artifact.collection !== undefined && <span>{artifact.collection}</span>}
          </p>
          <p class="mt-1 line-clamp-2 text-xs text-stone-600 dark:text-stone-400">
            {artifact.description}
          </p>
        </li>
      ))}
    </ul>
  );
};
