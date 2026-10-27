import { createApp } from './app.js';
import { OWNER_PASSWORD_MIN_LENGTH } from './auth/owner-auth.js';
import { currentEnvName } from './legacy-env.js';
import { WorkerConfigError, createWorkerServices } from './worker-services.js';
import type { WorkerEnv, WorkerServices } from './worker-services.js';
import { workerStaticFiles } from './worker-static-files.js';

// The Cloudflare Worker entry (ADR-0009); src/server.ts is the Node one. The
// Node build never imports this module or the worker-*.ts modules it uses.
//
// The services and the app are composed for each request rather than once
// per isolate. Composing is only object construction, and env arrives with
// each call, so the services use the bindings the request came with; only
// the public base URL is read from process.env by the shared app, and workerd
// fills that once per isolate from the same bindings. Composing per request
// also keeps per-request I/O apart: the URL signer caches its key lookups as
// promises, and workerd does not let one request safely await a promise that
// another request's I/O will settle. The cost is that the hourly signing key
// (ADR-0004) is read from D1 once per request that signs or checks a URL,
// rather than about once an hour.

// The handler's context, as far as this entry uses it.
type WorkerContext = { waitUntil: (promise: Promise<unknown>) => void };

// The public error for each setting. It names the setting and says what it
// must be, but never repeats its value, which may be a password or a URL with
// credentials in it.
const SETTING_MESSAGES = {
  MUNINN_OWNER_PASSWORD: `MUNINN_OWNER_PASSWORD must be set to a password of at least ${String(OWNER_PASSWORD_MIN_LENGTH)} characters. Set it with \`wrangler secret put MUNINN_OWNER_PASSWORD\`.`,
  MUNINN_PUBLIC_BASE_URL:
    'MUNINN_PUBLIC_BASE_URL must be set to the absolute http or https URL the Worker is reached at, with no credentials, query, or fragment. Set it with `wrangler secret put MUNINN_PUBLIC_BASE_URL`.',
} as const;

function configMessage({ legacyNames, setting }: WorkerConfigError): string {
  if (setting !== 'ARTIFACTS_*') {
    return SETTING_MESSAGES[setting];
  }
  const renames = legacyNames.map(
    (name) => `${name} is no longer read; rename it to ${currentEnvName(name)}.`,
  );
  return `Artifacts is now Muninn (ADR-0007).\n${renames.join('\n')}`;
}

class MisconfiguredError extends Error {
  constructor(message: string) {
    super(`Muninn is not configured: ${message}`);
    this.name = 'MisconfiguredError';
  }
}

// The settings, checked. A failed check throws an Error with configMessage's
// text, so the scheduled handler's failure in the logs names the setting
// without its value too.
function workerServices(env: WorkerEnv): WorkerServices {
  try {
    return createWorkerServices(env);
  } catch (error) {
    if (error instanceof WorkerConfigError) {
      throw new MisconfiguredError(configMessage(error));
    }
    throw error;
  }
}

// Settings that fail the checks in resolveWorkerConfig leave every request
// that reaches the Worker with only this: plain text that names the setting,
// never app content. Static Assets still serve the built files, which run
// before the Worker.
function misconfigured(error: MisconfiguredError): Response {
  console.error(error.message);
  return new Response(`${error.message}\n`, {
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    status: 500,
  });
}

const worker = {
  async fetch(request: Request, env: WorkerEnv, _ctx: WorkerContext): Promise<Response> {
    let services: WorkerServices;
    try {
      services = workerServices(env);
    } catch (error) {
      if (error instanceof MisconfiguredError) {
        return misconfigured(error);
      }
      throw error;
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
    await workerServices(env).secrets.sweep();
  },
};

export default worker;
