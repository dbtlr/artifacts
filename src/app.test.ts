import { describe, expect, it } from 'vite-plus/test';

import { app } from './app.js';

describe('app', () => {
  it('renders the homepage with the stylesheet linked', async () => {
    const res = await app.request('/');

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Artifacts');
    expect(body).toContain('/app.css');
  });
});
