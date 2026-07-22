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
// Vite itself only builds the Tailwind entry into a static CSS asset.
export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: 'dist/public',
    rollupOptions: {
      input: 'src/client/styles.css',
      output: {
        // Fixed filename (no content hash) so the server layout can link a
        // stable /assets/app.css path without reading a Vite manifest.
        assetFileNames: 'app.css',
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
});
