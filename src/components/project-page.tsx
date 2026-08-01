import type { FC } from 'hono/jsx';

import type { LegacyArtifact } from '../data/store.js';
import { ArtifactList } from './artifact-list.js';

type ProjectPageProps = { artifacts: LegacyArtifact[]; project: string };

export const ProjectPage: FC<ProjectPageProps> = ({ artifacts, project }) => (
  <main>
    <a href="/" class="text-sm text-stone-500 hover:underline">
      &larr; All artifacts
    </a>
    <h1 class="mt-2 text-3xl font-semibold tracking-tight">{project}</h1>
    <ArtifactList artifacts={artifacts} emptyMessage={`No artifacts in ${project} yet.`} />
  </main>
);
