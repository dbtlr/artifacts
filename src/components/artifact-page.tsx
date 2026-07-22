import { raw } from 'hono/html';
import type { FC } from 'hono/jsx';

import type { ArtifactWithContent } from '../data/store.js';
import { formatDate } from '../format-date.js';

// `renderedHtml` is set by the /a/:id route (app.tsx) exactly when
// `artifact.type === 'md'` — rendering is async (see markdown.ts), so it
// happens once in the route handler rather than inside this component.
// `txt` always leaves it undefined and keeps the plain <pre> path.
type ArtifactPageProps = { artifact: ArtifactWithContent; renderedHtml?: string };

export const ArtifactPage: FC<ArtifactPageProps> = ({ artifact, renderedHtml }) => (
  <article>
    <header class="border-b border-stone-200 pb-4 dark:border-stone-800">
      <h1 class="text-3xl font-semibold tracking-tight">{artifact.title}</h1>
      <p class="mt-1 text-sm text-stone-500 dark:text-stone-400">
        {artifact.project} · {formatDate(artifact.createdAt)}
      </p>
      <p class="mt-2 text-stone-600 dark:text-stone-300">{artifact.description}</p>
    </header>
    {renderedHtml === undefined ? (
      <pre class="mt-8 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-stone-200 bg-white p-4 font-mono text-sm leading-relaxed text-stone-800 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-200">
        {artifact.content}
      </pre>
    ) : (
      // The one spot in the app that intentionally injects markup instead of
      // escaping it: `renderedHtml` comes only from markdown.ts's
      // markdown-it pipeline (html: false, so no raw HTML from the artifact
      // itself survives into it) — never from artifact.content directly.
      <div class="prose prose-stone mt-8 max-w-none dark:prose-invert">{raw(renderedHtml)}</div>
    )}
  </article>
);
