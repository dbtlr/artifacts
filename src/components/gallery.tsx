import type { FC } from 'hono/jsx';

import type { Artifact } from '../data/store.js';
import { formatDate } from '../format-date.js';
import { kindOf } from '../index-view.js';
import { THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH } from '../thumbnails/placeholder.js';

export function projectHref(project: string): string {
  return `/p/${encodeURIComponent(project)}`;
}

type GalleryProps = { artifacts: Artifact[]; emptyMessage: string };

// The card grid shared by the home page and /p/:project. The store already
// returns newest-first; this renders order as given. The thumbnail is always
// an <img> pointing at /a/:id/thumb, which answers with a drawn placeholder
// until a rendered preview exists, so the markup never has to know which.
//
// Previews are mostly pure-black or pure-white pages, so they are drawn at
// 86% opacity inside a hairline frame: black lifts toward the page tone and
// white loses its glare, and the card comes to full strength on hover.
export const ArtifactGallery: FC<GalleryProps> = ({ artifacts, emptyMessage }) => {
  if (artifacts.length === 0) {
    return <p class="mt-8 text-stone-600 dark:text-ink-400">{emptyMessage}</p>;
  }

  return (
    <ul class="grid grid-cols-1 gap-x-9 gap-y-12 py-6 sm:grid-cols-2 lg:grid-cols-3">
      {artifacts.map((artifact) => (
        <li key={artifact.id} class="group">
          <a href={`/a/${artifact.id}`} class="block">
            <span class="block overflow-hidden rounded-md border border-stone-200 bg-stone-100 dark:border-ink-700 dark:bg-ink-850">
              <img
                src={`/a/${artifact.id}/thumb`}
                alt=""
                loading="lazy"
                width={THUMBNAIL_WIDTH}
                height={THUMBNAIL_HEIGHT}
                class="block aspect-[16/10] w-full object-cover object-top opacity-[.86] transition-opacity group-hover:opacity-100"
              />
            </span>
            <span class="mt-3.5 block text-[17px] leading-snug font-semibold text-stone-900 group-hover:underline dark:text-ink-100">
              {artifact.title}
            </span>
          </a>
          <p class="mt-1.5 text-[13px] text-stone-500 dark:text-ink-400">
            <a
              href={projectHref(artifact.project)}
              class="font-medium text-amber-700 hover:underline dark:text-accent"
            >
              {artifact.project}
            </a>
            <span class="mx-2 font-mono text-xs">{kindOf(artifact.mediaType)}</span>
            <span class="tabular-nums">{formatDate(artifact.createdAt, 'short')}</span>
            {artifact.collection !== undefined && <span class="ml-2">{artifact.collection}</span>}
          </p>
          <p class="mt-2 line-clamp-2 text-[15px] leading-normal text-stone-600 dark:text-ink-300">
            {artifact.description}
          </p>
        </li>
      ))}
    </ul>
  );
};
