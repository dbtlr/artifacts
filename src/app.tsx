import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

import { HomePage } from './components/home-page.js';
import { Layout } from './components/layout.js';

const app = new Hono();

// Serves the Vite build output (currently just app.css). serveStatic calls
// next() on a miss, so this falls through to the route handlers below.
app.use('/*', serveStatic({ root: './dist/public' }));

app.get('/', (c) =>
  c.html(
    <Layout title="Artifacts">
      <HomePage />
    </Layout>,
  ),
);

export { app };
