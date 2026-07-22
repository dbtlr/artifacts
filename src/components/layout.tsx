import type { FC, PropsWithChildren } from 'hono/jsx';

const STYLESHEET_HREF = '/app.css';

type LayoutProps = PropsWithChildren<{ title: string }>;

// Shared server-rendered shell. hono/jsx renders to a string on the server —
// there is no hydration and no client-side script.
export const Layout: FC<LayoutProps> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <link rel="stylesheet" href={STYLESHEET_HREF} />
    </head>
    <body class="min-h-screen bg-stone-50 text-stone-900 antialiased">
      <div class="mx-auto max-w-3xl px-4 py-10">{children}</div>
    </body>
  </html>
);
