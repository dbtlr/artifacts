import type { FC } from 'hono/jsx';

import type { LegacyArtifact } from '../data/store.js';
import { ArtifactList } from './artifact-list.js';

type HomePageProps = { artifacts: LegacyArtifact[] };

export const HomePage: FC<HomePageProps> = ({ artifacts }) => (
  <main>
    <h1 class="text-3xl font-semibold tracking-tight">Artifacts</h1>
    <p class="mt-2 text-stone-600">A preview environment for agent-authored documents.</p>
    <ArtifactList
      artifacts={artifacts}
      emptyMessage="No artifacts yet. Once an agent shares one, it will show up here."
    />
  </main>
);
