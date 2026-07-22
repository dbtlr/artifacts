import { raw } from 'hono/html';
import type { FC } from 'hono/jsx';

import type { ArtifactWithContent } from '../data/store.js';
import { formatDate } from '../format-date.js';
import type { RenderedMarkdown } from '../markdown.js';

// Fixed filename the vite config gives the mermaid entry (see
// vite.config.ts's `entryFileNames`) — a static path, like Layout's own
// STYLESHEET_HREF, not something read from a Vite manifest at request time.
const MERMAID_SCRIPT_SRC = '/assets/mermaid.js';

// `rendered` is set by the /a/:id route (app.tsx) exactly when
// `artifact.type === 'md'` — rendering is async (see markdown.ts), so it
// happens once in the route handler rather than inside this component.
// `txt` always leaves it undefined and keeps the plain <pre> path.
type ArtifactPageProps = { artifact: ArtifactWithContent; rendered?: RenderedMarkdown };

export const ArtifactPage: FC<ArtifactPageProps> = ({ artifact, rendered }) => (
  <article>
    <header class="border-b border-stone-200 pb-4 dark:border-stone-800">
      <h1 class="text-3xl font-semibold tracking-tight">{artifact.title}</h1>
      <p class="mt-1 text-sm text-stone-500 dark:text-stone-400">
        {artifact.project} · {formatDate(artifact.createdAt)}
      </p>
      <p class="mt-2 text-stone-600 dark:text-stone-300">{artifact.description}</p>
    </header>
    {rendered?.toc !== undefined && (
      // Between the metadata header above and the rendered content below,
      // as specced. `rendered.toc` is markdown.ts's own `<nav>` markup —
      // already-escaped labels and this-module-generated ids only (see
      // renderToc's comment in markdown.ts), so raw() injection here is
      // exactly as safe as the prose content's below, not a new risk.
      <div class="mt-6 rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
        {raw(rendered.toc)}
      </div>
    )}
    {rendered === undefined ? (
      <pre class="mt-8 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-stone-200 bg-white p-4 font-mono text-sm leading-relaxed text-stone-800 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-200">
        {artifact.content}
      </pre>
    ) : (
      // The one spot in the app that intentionally injects markup instead of
      // escaping it: `rendered.html` comes only from markdown.ts's
      // markdown-it pipeline (html: false, so no raw HTML from the artifact
      // itself survives into it) — never from artifact.content directly.
      <div class="prose prose-stone mt-8 max-w-none dark:prose-invert">{raw(rendered.html)}</div>
    )}
    {rendered?.hasMermaid === true && (
      // Zero client JS everywhere else in the app (see CLAUDE.md) — this tag
      // only ever appears when markdown.ts's own token-stream scan found a
      // ```mermaid fence in this exact document, so pages without a diagram
      // stay script-free. `src` is the fixed build-time path above, not
      // artifact content, so there's nothing here to escape.
      <script src={MERMAID_SCRIPT_SRC} type="module" />
    )}
  </article>
);
