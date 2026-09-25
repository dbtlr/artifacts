import type { FC, PropsWithChildren } from 'hono/jsx';

const STYLESHEET_HREF = '/assets/app.css';

// `wide` is for the gallery pages, whose card grid needs the room; the
// artifact reading pages keep the narrower measure.
type LayoutProps = PropsWithChildren<{ title: string; wide?: boolean }>;

// Shared server-rendered shell. hono/jsx renders to a string on the server —
// there is no hydration, and no client-side script here in the shell itself.
// (ArtifactPage conditionally adds the one script tag this app ever emits —
// the locally-bundled mermaid entry — only on md pages whose content
// actually contains a diagram; see its MERMAID_SCRIPT_SRC comment.)
// Dark mode uses the Ink palette (see the @theme block in client/styles.css):
// a near-black page with off-white text, never pure black on pure white.
export const Layout: FC<LayoutProps> = ({ title, wide = false, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="color-scheme" content="light dark" />
      <title>{title}</title>
      {/* PNG before SVG: Safari has no SVG-favicon support and takes the PNG;
          Chromium and Firefox prefer the SVG via its declared type. */}
      <link rel="icon" href="/assets/favicon-32.png" type="image/png" sizes="32x32" />
      <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
      <link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" />
      <link rel="stylesheet" href={STYLESHEET_HREF} />
    </head>
    <body class="min-h-screen bg-stone-50 text-stone-900 antialiased dark:bg-ink-950 dark:text-ink-300">
      <div class={wide ? 'mx-auto max-w-6xl px-10 pb-10' : 'mx-auto max-w-3xl px-4 py-10'}>
        {children}
      </div>
    </body>
  </html>
);
