import type { FC } from 'hono/jsx';

import type { ArtifactWithContent } from '../data/store.js';

type ArtifactPageProps = { artifact: ArtifactWithContent };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

// Renders md/txt artifacts inside the standard chrome. This is a placeholder
// for `md`: the real pipeline (server-side markdown, shiki syntax
// highlighting, mermaid code blocks, an auto-generated table of contents)
// lands in a later phase. Until then, md and txt both get the same
// treatment — escaped content in a wrapped, scrollable <pre> — so a shared
// link is at least readable in the meantime.
export const ArtifactPage: FC<ArtifactPageProps> = ({ artifact }) => (
  <article>
    <header class="border-b border-stone-200 pb-4">
      <h1 class="text-3xl font-semibold tracking-tight">{artifact.title}</h1>
      <p class="mt-1 text-sm text-stone-500">
        {artifact.project} · {formatDate(artifact.createdAt)}
      </p>
      <p class="mt-2 text-stone-600">{artifact.description}</p>
    </header>
    <pre class="mt-8 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-stone-200 bg-white p-4 font-mono text-sm leading-relaxed text-stone-800">
      {artifact.content}
    </pre>
  </article>
);
