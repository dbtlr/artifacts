import type { MiddlewareHandler } from 'hono';

import type { StaticFileInstaller } from './app.js';

// The part of a Workers Static Assets binding that the installer uses. It is
// declared here because the Workers runtime types are global declarations
// that clash with the DOM lib this project compiles against.
export type AssetsBinding = {
  fetch: (request: Request) => Promise<Response>;
};

// The root icon endpoints and the dist/public file each serves, as in
// static-files.ts: /favicon.ico gets the 32px PNG.
const ICON_FILES = {
  '/apple-touch-icon.png': '/apple-touch-icon.png',
  '/favicon.ico': '/favicon-32.png',
  '/favicon.svg': '/favicon.svg',
} as const;

const READ_METHODS = new Set(['GET', 'HEAD']);

// Serves one file of dist/public from Static Assets, keeping the request's
// method and headers so a conditional request still gets a 304. A miss, or a
// method that cannot read a file, falls through to the routes below, as
// serveStatic does on Node.
function serveAsset(assets: AssetsBinding, fileOf: (path: string) => string): MiddlewareHandler {
  return async (c, next) => {
    if (!READ_METHODS.has(c.req.method)) {
      return next();
    }
    const url = new URL(c.req.url);
    url.pathname = fileOf(url.pathname);
    const res = await assets.fetch(new Request(url, c.req.raw));
    return res.status === 404 ? next() : res;
  };
}

// The Worker's static-file routes, passed to createApp by worker.ts. Static
// Assets already serves dist/public at the site root before the Worker runs,
// so these cover the paths the app links to that are not files there:
// /assets/* with its prefix stripped, and /favicon.ico. The /favicon.svg and
// /apple-touch-icon.png routes are kept for parity with Node; in production
// Static Assets answer them first.
export function workerStaticFiles(assets: AssetsBinding): StaticFileInstaller {
  return (app) => {
    app.use(
      '/assets/*',
      serveAsset(assets, (path) => path.replace(/^\/assets/u, '')),
    );
    for (const [path, file] of Object.entries(ICON_FILES)) {
      app.use(
        path,
        serveAsset(assets, () => file),
      );
    }
  };
}
