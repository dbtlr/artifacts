import mermaid from 'mermaid';

// The only client-side script in the app (see CLAUDE.md), loaded only on
// pages whose rendered markdown actually contains a ```mermaid fence — see
// `hasMermaid` in src/markdown.ts and its use in src/app.tsx. markdown.ts's
// renderer already emitted each diagram's source, text-escaped, as
// `<pre class="mermaid">`; mermaid's own `startOnLoad` scans the document for
// exactly that selector and replaces each one with its rendered SVG.
//
// Theme follows `prefers-color-scheme`, decided once at init rather than
// re-rendering on a live scheme change — the rest of this zero-client-JS app
// (shiki's dual CSS-variable themes, Tailwind's `dark:` variant) already
// treats color scheme as fixed for the life of a page view, so matching that
// is simpler and consistent, not a compromise.
const prefersDark = globalThis.matchMedia('(prefers-color-scheme: dark)').matches;

mermaid.initialize({
  securityLevel: 'strict',
  startOnLoad: true,
  theme: prefersDark ? 'dark' : 'default',
});
