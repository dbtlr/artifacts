import type { FC } from 'hono/jsx';

import type { ApiKeySummary } from '../auth/types.js';
import { formatDate } from '../format-date.js';

type ApiKeysPageProps = {
  // A key created by this request. Its secret is shown here once and never
  // again, because only its hash is stored.
  created?: { key: string; name: string };
  // Shown above the create form after a refused request.
  error?: string;
  keys: ApiKeySummary[];
  // The absolute /mcp URL that agents connect to.
  mcpUrl: string;
};

const button =
  'cursor-pointer border border-stone-900 bg-stone-900 px-3 py-2 font-semibold text-white dark:border-ink-100 dark:bg-ink-100 dark:text-ink-950';
const muted = 'text-sm text-stone-500 dark:text-ink-400';

// The owner's API keys for /mcp: plain form POSTs, so it works without
// script. Creating a key shows its secret once; revoking deletes it.
export const ApiKeysPage: FC<ApiKeysPageProps> = ({ created, error, keys, mcpUrl }) => (
  <main>
    <a href="/" class="text-lg font-bold tracking-tight text-stone-900 dark:text-ink-100">
      a<span class="text-amber-600 dark:text-accent">.</span> Artifacts
    </a>
    <h1 class="mt-6 text-xl font-bold text-stone-900 dark:text-ink-100">API keys</h1>
    <p class={`mt-2 ${muted}`}>
      Agents send a key to <code>{mcpUrl}</code> as <code>Authorization: Bearer &lt;key&gt;</code>.
    </p>
    {created === undefined ? null : (
      <section class="mt-6 border border-amber-600 p-4 dark:border-accent">
        <p class="text-sm text-stone-900 dark:text-ink-100">
          New key for <strong>{created.name}</strong>. Copy it now: it is not shown again.
        </p>
        <code class="mt-2 block font-mono text-sm break-all text-stone-900 select-all dark:text-ink-100">
          {created.key}
        </code>
      </section>
    )}
    <form method="post" action="/keys" class="mt-6 flex flex-wrap items-end gap-3">
      <label for="name" class="flex flex-col gap-1 text-sm text-stone-700 dark:text-ink-300">
        Name
        <input
          id="name"
          name="name"
          type="text"
          maxlength={100}
          required
          class="border border-stone-300 bg-white px-3 py-2 text-stone-900 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-100"
        />
      </label>
      <button type="submit" class={button}>
        Create key
      </button>
    </form>
    {error === undefined ? null : (
      <p role="alert" class="mt-2 text-sm text-red-700 dark:text-red-400">
        {error}
      </p>
    )}
    {keys.length === 0 ? (
      <p class={`mt-6 ${muted}`}>No keys yet.</p>
    ) : (
      <table class="mt-6 w-full text-left text-sm">
        <thead class={muted}>
          <tr>
            <th class="py-1 font-normal">Name</th>
            <th class="py-1 font-normal">Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.id} class="border-t border-stone-200 dark:border-ink-800">
              <td class="py-2 break-all text-stone-900 dark:text-ink-100">{key.name}</td>
              <td class="py-2 whitespace-nowrap">{formatDate(key.createdAt, 'short')}</td>
              <td class="py-2 text-right">
                <form method="post" action={`/keys/${encodeURIComponent(key.id)}/revoke`}>
                  <button
                    type="submit"
                    class="cursor-pointer text-red-700 hover:underline dark:text-red-400"
                  >
                    Revoke
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </main>
);
