import type { FC } from 'hono/jsx';

type NotFoundPageProps = { id: string };

export const NotFoundPage: FC<NotFoundPageProps> = ({ id }) => (
  <main>
    <h1 class="text-3xl font-semibold tracking-tight">Artifact not found</h1>
    <p class="mt-2 text-stone-600">
      No artifact exists with id <code class="rounded bg-stone-100 px-1 py-0.5">{id}</code>. It may
      have been removed, or the link may be incorrect.
    </p>
  </main>
);
