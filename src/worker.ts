import { createApp } from './app.js';
import { createWorkerServices } from './worker-services.js';
import type { WorkerEnv, WorkerServices } from './worker-services.js';
import { workerStaticFiles } from './worker-static-files.js';

// The Cloudflare Worker entry (ADR-0009); src/server.ts is the Node one. The
// Node build never imports this module or the worker-*.ts modules it uses.
//
// The services and the app are composed for each request rather than once
// per isolate. Composing is only object construction, and env arrives with
// each call, so a request is always served from the bindings it came with.
// It also keeps per-request I/O apart: the URL signer caches its key lookups
// as promises, and workerd does not let one request safely await a promise
// that another request's I/O will settle. The cost is that the hourly
// signing key (ADR-0004) is read from D1 once per request that signs or
// checks a URL, rather than about once an hour.

// The handler's context, as far as this entry uses it.
type WorkerContext = { waitUntil: (promise: Promise<unknown>) => void };

// Settings that fail the checks in resolveWorkerConfig leave the Worker
// serving only this: plain text that names the setting, never app content.
function misconfigured(error: unknown): Response {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Muninn is not configured: ${detail}`);
  return new Response(`Muninn is not configured: ${detail}\n`, {
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    status: 500,
  });
}

const worker = {
  async fetch(request: Request, env: WorkerEnv, _ctx: WorkerContext): Promise<Response> {
    let services: WorkerServices;
    try {
      services = createWorkerServices(env);
    } catch (error) {
      return misconfigured(error);
    }
    const app = createApp(services, undefined, workerStaticFiles(env.ASSETS));
    return app.fetch(request, env);
  },

  // The Cron Trigger in wrangler.jsonc, every 10 minutes like Node's timer:
  // removes expired one-time secrets, upload slots, and claims. The sweep is
  // awaited rather than passed to waitUntil, so a failure fails this run and
  // shows in the Worker's logs; the rows it missed stay unreadable, since
  // every read checks expiry itself. Misconfigured settings throw here.
  async scheduled(_controller: unknown, env: WorkerEnv, _ctx: WorkerContext): Promise<void> {
    await createWorkerServices(env).secrets.sweep();
  },
};

export default worker;
