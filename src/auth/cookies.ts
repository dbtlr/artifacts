import type { CookieOptions } from 'hono/utils/cookie';

import { resolvePublicBaseUrl } from '../urls.js';

// The options of a cookie that carries something shown once, such as a new
// API key or a new secret's handle, from a form's POST to the GET its
// redirect asks for. It is sent only to that page, never to a script or a
// cross-site request, and only over HTTPS when the public base URL is HTTPS.
export function showOnceCookieOptions(path: string): CookieOptions {
  return {
    httpOnly: true,
    path,
    sameSite: 'Strict',
    secure: resolvePublicBaseUrl().startsWith('https:'),
  };
}
