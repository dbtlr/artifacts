import { defineConfig, toolingPlugin } from '@dbtlr/tooling';
import tailwindcss from '@tailwindcss/vite';

// Composition path: toolingPlugin batteries (node: true) — the app is a plain
// Hono/Node server (run directly via tsx, no server-side bundling). Vite's only
// job here is compiling the Tailwind entry into a static CSS asset the server
// serves; @tailwindcss/vite is added alongside the batteries plugin.
export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: 'dist/public',
    rollupOptions: {
      input: 'src/client/styles.css',
      output: {
        // Fixed filename (no content hash) so the server layout can link a
        // stable /app.css path without reading a Vite manifest.
        assetFileNames: 'app.css',
      },
    },
  },
  plugins: [toolingPlugin({ node: true }), tailwindcss()],
});
