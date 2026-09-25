import type { FC } from 'hono/jsx';

import type { CountedProject, IndexView } from '../index-view.js';
import { projectHref } from './gallery.js';

type IndexHeaderProps = {
  // Where the kind links point: `/` on the home page, `/p/:project` on a
  // project page, so a kind filter stays inside the project.
  basePath: string;
  // The project a project page is scoped to; undefined on the home page.
  current?: string;
  // Every project with its count, for the selector, regardless of scope.
  projects: CountedProject[];
  // Kind counts and the active kind come from the page's own (scoped) view.
  view: IndexView;
};

const count = 'ml-1.5 text-xs text-stone-500 tabular-nums dark:text-ink-400';
const kindLink =
  'whitespace-nowrap text-stone-500 hover:text-stone-900 dark:text-ink-400 dark:hover:text-ink-100';
const kindLinkOn = 'whitespace-nowrap font-semibold text-stone-900 dark:text-ink-100';
const menuLink =
  'block break-inside-avoid py-1 text-stone-700 hover:text-stone-900 dark:text-ink-300 dark:hover:text-ink-100';

function artifactsLabel(total: number): string {
  return total === 1 ? '1 artifact' : `${String(total)} artifacts`;
}

// One header bar that carries the navigation: wordmark, a project selector,
// the kind links, and the count. The selector is a plain <details> element,
// so it opens without any script, and every link in it is a server-rendered
// anchor.
//
// Narrow screens: the bar and the kind links both wrap rather than squash,
// nothing breaks inside a word, a long project name truncates but keeps its
// caret, and the open menu is anchored to the header's own box (not the
// selector), so it can never extend past the viewport.
export const IndexHeader: FC<IndexHeaderProps> = ({ basePath, current, projects, view }) => (
  <header class="relative flex flex-wrap items-center gap-x-7 gap-y-2 border-b border-stone-200 py-4 dark:border-ink-800">
    <a
      href="/"
      class="mr-3 shrink-0 text-lg font-bold tracking-tight whitespace-nowrap text-stone-900 dark:text-ink-100"
    >
      a<span class="text-amber-600 dark:text-accent">.</span> Artifacts
    </a>
    <details class="min-w-0">
      <summary class="flex max-w-64 cursor-pointer list-none items-baseline font-semibold text-stone-900 select-none dark:text-ink-100 [&::-webkit-details-marker]:hidden">
        <span class="min-w-0 truncate">{current ?? 'All projects'}</span>
        <span class="ml-1 shrink-0 font-normal text-stone-400 dark:text-ink-400">&#9662;</span>
      </summary>
      <div class="absolute top-full left-0 z-10 mt-1 w-full max-w-[600px] columns-2 gap-x-8 border border-stone-200 bg-white px-4 py-3 shadow-lg sm:columns-3 dark:border-ink-800 dark:bg-ink-900 dark:shadow-black/50">
        <a href="/" class={menuLink}>
          <span>All projects</span>
          <span class={count}>{projects.reduce((sum, project) => sum + project.count, 0)}</span>
        </a>
        {projects.map((project) => (
          <a key={project.name} href={projectHref(project.name)} class={menuLink}>
            <span>{project.name}</span>
            <span class={count}>{project.count}</span>
          </a>
        ))}
      </div>
    </details>
    <nav class="ml-auto flex flex-wrap items-baseline gap-x-5 gap-y-2">
      <a href={basePath} class={view.kind === undefined ? kindLinkOn : kindLink}>
        All kinds
      </a>
      {view.kinds.map((entry) => (
        <a
          key={entry.kind}
          href={`${basePath}?kind=${entry.kind}`}
          class={view.kind === entry.kind ? kindLinkOn : kindLink}
        >
          <span>{entry.kind}</span>
          <span class={count}>{entry.count}</span>
        </a>
      ))}
      <span class="hidden text-[13px] whitespace-nowrap text-stone-500 tabular-nums sm:inline dark:text-ink-400">
        {artifactsLabel(view.total)}
      </span>
    </nav>
  </header>
);
