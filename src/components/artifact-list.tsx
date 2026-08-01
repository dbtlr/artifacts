import type { FC } from 'hono/jsx';

import type { LegacyArtifact } from '../data/store.js';
import { formatDate } from '../format-date.js';

type ArtifactListProps = { artifacts: LegacyArtifact[]; emptyMessage: string };

// Shared by the homepage (all artifacts) and /p/:project (filtered) —
// `store.listArtifacts` already returns newest-first, so this just renders
// order as given. Project links are URL-encoded so a project name with a
// space or slash still round-trips through /p/:project (see app.tsx, which
// decodes the param back via Hono's c.req.param()).
export const ArtifactList: FC<ArtifactListProps> = ({ artifacts, emptyMessage }) => {
  if (artifacts.length === 0) {
    return <p class="mt-8 text-stone-600">{emptyMessage}</p>;
  }

  return (
    <ul class="mt-8 divide-y divide-stone-200 border-t border-stone-200">
      {artifacts.map((artifact) => (
        <li key={artifact.id} class="py-4">
          <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <a
              href={`/a/${artifact.id}`}
              class="text-lg font-medium text-stone-900 hover:underline"
            >
              {artifact.title}
            </a>
            <span class="text-sm text-stone-500">{formatDate(artifact.createdAt)}</span>
          </div>
          <a
            href={`/p/${encodeURIComponent(artifact.project)}`}
            class="mt-1 inline-block text-sm text-stone-500 hover:underline"
          >
            {artifact.project}
          </a>
          <p class="mt-1 text-stone-600">{artifact.description}</p>
        </li>
      ))}
    </ul>
  );
};
