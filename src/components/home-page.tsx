import type { FC } from 'hono/jsx';

// Placeholder homepage — the real artifact listing lands in a later task. The
// `prose` block demonstrates @tailwindcss/typography rendering.
export const HomePage: FC = () => (
  <main>
    <h1 class="text-3xl font-semibold tracking-tight">Artifacts</h1>
    <p class="mt-2 text-stone-600">A preview environment for agent-authored documents.</p>
    <article class="prose prose-stone mt-8 max-w-none">
      <h2>Sample artifact</h2>
      <p>
        This placeholder demonstrates the <code>prose</code> typography plugin rendering
        markdown-ish content: <strong>bold</strong>, <em>emphasis</em>, and lists.
      </p>
      <ul>
        <li>
          Server-rendered with <code>hono/jsx</code> — no client JavaScript.
        </li>
        <li>
          Styled with Tailwind v4 and <code>@tailwindcss/typography</code>.
        </li>
        <li>Static assets served from the Vite build output.</li>
      </ul>
      <blockquote>Real artifact listings arrive in a later task.</blockquote>
    </article>
  </main>
);
