import type { FC } from 'hono/jsx';

import type { IndexView } from '../index-view.js';
import { ArtifactGallery, GalleryFilters } from './gallery.js';
import { PageHeader } from './page-header.js';

type HomePageProps = { view: IndexView };

export const HomePage: FC<HomePageProps> = ({ view }) => (
  <main>
    <PageHeader
      summary={`${String(view.total)} artifacts · ${String(view.projects.length)} projects`}
    />
    <GalleryFilters basePath="/" view={view} />
    <ArtifactGallery
      artifacts={view.items}
      emptyMessage="No artifacts yet. Once an agent shares one, it will show up here."
    />
  </main>
);
