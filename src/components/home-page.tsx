import type { FC } from 'hono/jsx';

import type { IndexView } from '../index-view.js';
import { ArtifactGallery, GalleryFilters } from './gallery.js';
import { PageHeader } from './page-header.js';

type HomePageProps = { view: IndexView };

// An empty grid means one of two things: nothing has been shared yet, or the
// active kind filter excluded everything.
function emptyMessage(view: IndexView): string {
  return view.kind !== undefined && view.total > 0
    ? `No ${view.kind} artifacts yet.`
    : 'No artifacts yet. Once an agent shares one, it will show up here.';
}

export const HomePage: FC<HomePageProps> = ({ view }) => (
  <main>
    <PageHeader
      summary={`${String(view.total)} artifacts · ${String(view.projects.length)} projects`}
    />
    <GalleryFilters basePath="/" view={view} />
    <ArtifactGallery artifacts={view.items} emptyMessage={emptyMessage(view)} />
  </main>
);
