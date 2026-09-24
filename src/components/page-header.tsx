import type { FC, PropsWithChildren } from 'hono/jsx';

type PageHeaderProps = PropsWithChildren<{ summary: string }>;

// Shared top strip for the gallery pages: the wordmark (a link home) and a
// one-line count on the right, with the page's own heading below when given.
export const PageHeader: FC<PageHeaderProps> = ({ summary, children }) => (
  <header class="pb-3">
    <div class="flex items-baseline justify-between gap-4">
      <a href="/" class="text-base font-bold tracking-tight">
        a<span class="text-amber-600 dark:text-amber-500">.</span> Artifacts
      </a>
      <span class="text-xs text-stone-500 tabular-nums dark:text-stone-500">{summary}</span>
    </div>
    {children}
  </header>
);
