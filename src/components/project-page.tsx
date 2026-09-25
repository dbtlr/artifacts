import type { FC } from 'hono/jsx';

import type { CountedProject, IndexView } from '../index-view.js';
import { ArtifactGallery, projectHref } from './gallery.js';
import { IndexHeader } from './index-header.js';

type ProjectPageProps = {
  project: string;
  // Every project with counts, so the selector can switch projects directly.
  projects: CountedProject[];
  // The project-scoped view: its items, kinds, and total.
  view: IndexView;
};

// An empty grid means one of two things: the project has nothing, or the
// active kind filter excluded everything it has.
function emptyMessage(project: string, view: IndexView): string {
  return view.kind !== undefined && view.total > 0
    ? `No ${view.kind} artifacts in ${project}.`
    : `No artifacts in ${project} yet.`;
}

export const ProjectPage: FC<ProjectPageProps> = ({ project, projects, view }) => (
  <main>
    <IndexHeader
      basePath={projectHref(project)}
      current={project}
      projects={projects}
      view={view}
    />
    <ArtifactGallery artifacts={view.items} emptyMessage={emptyMessage(project, view)} />
  </main>
);
