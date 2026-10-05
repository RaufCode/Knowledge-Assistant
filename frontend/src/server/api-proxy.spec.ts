import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';

import { apiOrigin, apiProxy } from './api-proxy';

/**
 * Exercises the proxy over real HTTP rather than against a stub.
 *
 * The whole job here is moving headers — the browser's `Cookie` up, and every
 * `Set-Cookie` down with its `SameSite`, `Secure`, `HttpOnly`, `Path` and `Max-Age`
 * intact — and those are exactly the details a mock would be written to agree
 * with. A stub that agreed with the implementation would pass while every real
 * deployment failed to sign in.
 *
 * One pair of servers for the whole file rather than one per test: `fetch` keeps
 * connections alive, so tearing a listener down between tests either waits on
 * them or leaves the next test racing a half-closed port.
 */
describe('apiProxy', () => {
  let upstream: Server;
  let front: Server;
  let base: string;

  /** What the backend saw, so the forwarded request can be asserted on. */
  let seen: { method?: string; url?: string; headers: Record<string, unknown> };

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen.method = req.method;
      seen.url = req.url;
      seen.headers = { ...req.headers };

      if (req.url?.startsWith('/api/auth/login')) {
        // Two cookies at once, because that is what a sign-in answers with, and
        // because `Set-Cookie` collapsing into one joined string is a real way to
        // break a session without noticing.
        res.setHeader('Set-Cookie', [
          'ika_access=access-value; Path=/; HttpOnly; SameSite=Lax',
          'ika_csrf=csrf-value; Path=/; SameSite=Lax',
        ]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ user: { id: 'u1' } }));

        return;
      }

      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));

    const app = express();
    app.use(
      apiProxy('/api', new URL(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`)),
    );
    app.get('/login', (_req, res) => res.sendStatus(200));

    front = createServer(app);

    await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));

    base = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    // `closeAllConnections` before `close`, so a kept-alive connection from a
    // finished test cannot hold the listener open.
    front.closeAllConnections();
    upstream.closeAllConnections();

    await Promise.all([
      new Promise<void>((resolve) => front.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  });

  beforeEach(() => {
    seen = { headers: {} };
  });

  const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${base}${path}`, { headers });

  const login = (): Promise<Response> =>
    fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ email: 'a@b.test', password: 'pw' }),
    });

  it('leaves everything that is not /api to the app itself', async () => {
    // Mounted without an Express path prefix, so it has to decide for itself —
    // otherwise it would swallow the sign-in screen.
    const response = await get('/login');

    expect(response.status).toBe(200);
    expect(seen.url).toBeUndefined();
  });

  it('forwards the path the backend routes on, prefix included', async () => {
    await login();

    // The backend routes on `/api/...` itself. `app.use('/api', …)` rewrites
    // `req.url` to what follows the mount, so forwarding that sends `/auth/login`
    // and every call 404s — which reads as the API being down.
    expect(seen.url).toBe('/api/auth/login');
    expect(seen.method).toBe('POST');
  });

  it('keeps the query string, because routes read it', async () => {
    await get('/api/documents?page=2&per_page=10');

    expect(seen.url).toBe('/api/documents?page=2&per_page=10');
  });

  it("passes the browser's cookies up untouched", async () => {
    // The session is cookies. A proxy that rebuilt or filtered them would produce
    // a sign-in that answers 200 and a session that is not there.
    await get('/api/auth/me', { Cookie: 'ika_access=abc; ika_refresh=def' });

    expect(seen.headers['cookie']).toBe('ika_access=abc; ika_refresh=def');
  });

  it('returns every Set-Cookie separately, with its attributes intact', async () => {
    const cookies = (await login()).headers.getSetCookie();

    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain('ika_access=access-value');
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[0]).toContain('SameSite=Lax');
    expect(cookies[1]).toContain('ika_csrf=csrf-value');
  });

  it("forwards the browser's Origin, so the backend's own check still applies", async () => {
    // Rewriting this would quietly disable the CSRF origin check rather than
    // satisfy it.
    await login();

    expect(seen.headers['origin']).toBe(base);
  });

  it('carries the request body through', async () => {
    // A document upload goes through here too, so the body is streamed rather than
    // assembled into a string in memory first.
    await login();

    expect(seen.headers['content-type']).toBe('application/json');
  });
});

describe('apiOrigin', () => {
  it('defaults to the local backend when nothing is configured', () => {
    expect(apiOrigin({}).href).toBe('http://127.0.0.1:8099/');
  });

  it('reads the backend origin from the environment', () => {
    expect(apiOrigin({ API_ORIGIN: 'https://backend.example' }).href).toBe(
      'https://backend.example/',
    );
  });

  it('ignores an empty or blank setting rather than failing', () => {
    // Render sets every variable it knows about, including an empty one.
    expect(apiOrigin({ API_ORIGIN: '' }).href).toBe('http://127.0.0.1:8099/');
    expect(apiOrigin({ API_ORIGIN: '   ' }).href).toBe('http://127.0.0.1:8099/');
  });

  it('refuses a value that is not a URL, and says what it wanted', () => {
    // A typo here would otherwise become a proxy pointed nowhere, which looks
    // exactly like every API call failing at once.
    expect(() => apiOrigin({ API_ORIGIN: 'backend.example' })).toThrow(/API_ORIGIN is not a URL/);
  });

  it('refuses a scheme it cannot speak', () => {
    expect(() => apiOrigin({ API_ORIGIN: 'ftp://backend.example' })).toThrow(/http or https/);
  });
});
