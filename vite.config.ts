import { defineConfig, toolingPlugin } from '@dbtlr/tooling';
import tailwindcss from '@tailwindcss/vite';

// Composition path: toolingPlugin batteries (node: true, pack) — `dev` runs the
// server straight off src/ via tsx watch, but `build` needs a real production
// artifact: a prod-only `npm/pnpm install` skips devDependencies (tsx included),
// so shipping TS source for tsx to run at start time breaks a slim Docker image.
// `pack` (tsdown under the hood) bundles src/server.ts and its local imports —
// including the hono/jsx components — into dist/server.js, keeping `hono` and
// `@hono/node-server` external (they're real "dependencies", present after a
// prod install). `fixedExtension: false` picks the plain `.js` extension (this
// package.json is `"type": "module"`) so `node dist/server.js` just works.
// Vite itself builds the static assets: the Tailwind stylesheet and the two
// client-side scripts, src/client/highlight.ts (shiki) and
// src/client/mermaid.ts. Both are large dependencies, so they must stay
// Vite-built static assets, never something `pack` pulls into the server
// bundle: dist/server.js never imports src/client/.
export default defineConfig({
  // Static assets are served under /assets (see serveStatic in app.tsx, which
  // strips that prefix and reads from dist/public). Vite's own default base
  // ("/") assumes the build output is served from the site root, so without
  // this, the scripts' code-split chunk imports (mermaid lazily imports a
  // module per diagram type, and highlight.js one per grammar) resolve to
  // bare root-relative paths like /chunks/<name>-<hash>.js instead of
  // /assets/chunks/<name>-<hash>.js — a 404 in the browser even though the
  // file exists right there in dist/public.
  base: '/assets/',
  build: {
    // Mermaid's own largest lazily-loaded diagram-renderer chunk is ~663 kB
    // — expected and fine (it's an extra chunk file, only fetched for the
    // diagram type actually used, never the server bundle); raised past that
    // so the build doesn't print a size warning for a chunk that's supposed
    // to be that size.
    chunkSizeWarningLimit: 700,
    emptyOutDir: true,
    outDir: 'dist/public',
    rollupOptions: {
      input: {
        highlight: 'src/client/highlight.ts',
        mermaid: 'src/client/mermaid.ts',
        styles: 'src/client/styles.css',
      },
      output: {
        // Fixed filenames (no content hash) so the server layout/artifact
        // page can link stable /assets/app.css, /assets/highlight.js, and
        // /assets/mermaid.js paths without reading a Vite manifest. The
        // lazily imported chunks behind them (diagram types, grammars,
        // themes) still get hashed names via chunkFileNames below, so they
        // cache-bust normally; only the entry points the server links to
        // need fixed names.
        assetFileNames: 'app.css',
        chunkFileNames: 'chunks/[name]-[hash].js',
        entryFileNames: '[name].js',
      },
    },
  },
  plugins: [
    toolingPlugin({
      lint: {
        overrides: [
          // The data store is single-user KISS: synchronous fs calls paired
          // with node:sqlite's synchronous DatabaseSync, not async I/O we
          // forgot to await.
          { files: ['src/data/**/*.ts'], rules: { 'node/no-sync': 'off' } },
        ],
      },
      node: true,
      pack: { dts: false, entry: ['src/server.ts'], exports: false, fixedExtension: false },
    }),
    tailwindcss(),
  ],
  // Favicon files, copied verbatim into dist/public alongside the built
  // assets. Kept under src/ (not the default ./public) so the Docker builder
  // stage — which only COPYs src plus the config files — still ships them.
  publicDir: 'src/public',
  staged: {
    '*': 'vp check --fix',
  },
});
