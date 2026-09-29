import { raw } from 'hono/html';
import type { FC } from 'hono/jsx';

import type { LegacyArtifactWithContent } from '../data/store.js';
import { formatDate } from '../format-date.js';
import type { RenderedMarkdown } from '../markdown.js';

// Fixed filenames the vite config gives the client entries (see
// vite.config.ts's `entryFileNames`) — static paths, like Layout's own
// STYLESHEET_HREF, not something read from a Vite manifest at request time.
const HIGHLIGHT_SCRIPT_SRC = '/assets/highlight.js';
const MERMAID_SCRIPT_SRC = '/assets/mermaid.js';

// `rendered` is set by the /a/:id route (app.tsx) exactly when
// `artifact.type === 'md'`, so markdown rendering happens once in the route
// handler rather than inside this component. `txt` always leaves it
// undefined and keeps the plain <pre> path.
type ArtifactPageProps = { artifact: LegacyArtifactWithContent; rendered?: RenderedMarkdown };

export const ArtifactPage: FC<ArtifactPageProps> = ({ artifact, rendered }) => (
  <article>
    <header class="border-b border-stone-200 pb-4 dark:border-ink-800">
      <h1 class="text-3xl font-semibold tracking-tight dark:text-ink-100">{artifact.title}</h1>
      <p class="mt-1 text-sm text-stone-500 dark:text-ink-400">
        {artifact.project} · {formatDate(artifact.createdAt)}
      </p>
      <p class="mt-2 text-stone-600 dark:text-ink-300">{artifact.description}</p>
    </header>
    {rendered?.toc !== undefined && (
      // Between the metadata header above and the rendered content below,
      // as specced. `rendered.toc` is markdown.ts's own `<nav>` markup —
      // already-escaped labels and this-module-generated ids only (see
      // renderToc's comment in markdown.ts), so raw() injection here is
      // exactly as safe as the prose content's below, not a new risk.
      <div class="mt-6 rounded-lg border border-stone-200 bg-white p-4 dark:border-ink-800 dark:bg-ink-900">
        {raw(rendered.toc)}
      </div>
    )}
    {rendered === undefined ? (
      <pre class="mt-8 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-stone-200 bg-white p-4 font-mono text-sm leading-relaxed text-stone-800 dark:border-ink-800 dark:bg-ink-900 dark:text-ink-300">
        {artifact.content}
      </pre>
    ) : (
      // The one spot in the app that intentionally injects markup instead of
      // escaping it: `rendered.html` comes only from markdown.ts's
      // markdown-it pipeline (html: false, so no raw HTML from the artifact
      // itself survives into it) — never from artifact.content directly.
      <div class="prose prose-stone mt-8 max-w-none dark:prose-invert">{raw(rendered.html)}</div>
    )}
    {/* Client scripts only enhance the already-rendered page, and each tag
        appears only when markdown.ts's token-stream scan found something in
        this exact document for it to do, so a page with neither stays
        script-free. `src` is a fixed build-time path above, not artifact
        content, so there's nothing here to escape. */}
    {rendered?.hasHighlightableCode === true && <script src={HIGHLIGHT_SCRIPT_SRC} type="module" />}
    {rendered?.hasMermaid === true && <script src={MERMAID_SCRIPT_SRC} type="module" />}
  </article>
);
