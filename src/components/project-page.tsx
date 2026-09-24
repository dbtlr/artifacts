import type { FC } from 'hono/jsx';

import type { IndexView } from '../index-view.js';
import { ArtifactGallery, GalleryFilters, projectHref } from './gallery.js';
import { PageHeader } from './page-header.js';

type ProjectPageProps = { project: string; view: IndexView };

export const ProjectPage: FC<ProjectPageProps> = ({ project, view }) => (
  <main>
    <PageHeader summary={`${String(view.total)} artifacts`}>
      <a href="/" class="text-sm text-stone-500 hover:underline dark:text-stone-400">
        &larr; All artifacts
      </a>
      <h1 class="mt-1 text-2xl font-semibold tracking-tight">{project}</h1>
    </PageHeader>
    <GalleryFilters basePath={projectHref(project)} view={view} />
    <ArtifactGallery artifacts={view.items} emptyMessage={`No artifacts in ${project} yet.`} />
  </main>
);
