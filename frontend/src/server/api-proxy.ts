import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { RequestHandler } from 'express';

/**
 * Forwards `/api` to the backend, so the app and the API share one origin.
 *
 * This exists because of how browsers decide about cookies, and it is the whole
 * reason a session works at all.
 *
 * The session is two `httpOnly` cookies. Whether the browser attaches them to an
 * API call is decided by the *site* — the registrable domain — and not by the app.
 * With the API on its own host the call is cross-site, and each browser then
 * applies its own policy to it: Safari and Chrome block or partition third-party
 * cookies outright, and `SameSite=Lax` withholds the cookies from every `fetch`
 * that is not same-site. The failure looks identical from the app — the sign-in
 * request returns 200, and the very next call comes back 401 — and it appears and
 * disappears with the browser and the device rather than with anything in the
 * code. That is the "you signed in, but this browser did not keep the session"
 * report.
 *
 * Serving the API through this process makes every `/api` call same-origin, so the
 * cookies are first-party by construction: no `SameSite=None`, no third-party
 * cookie policy, and no dependence on how the host happens to be spelled. It also
 * means the cookie is host-only for whatever address the app was opened at, so
 * `localhost`, `127.0.0.1`, a phone on the same wifi and the deployed domain all
 * behave identically instead of each needing their own cookie policy.
 *
 * Headers are forwarded rather than reconstructed, which is what keeps the session
 * working: the browser's `Cookie` goes up untouched, and every `Set-Cookie` the
 * backend answers with comes back untouched, including the `SameSite`, `Secure`,
 * `HttpOnly`, `Path` and `Max-Age` attributes that define the cookie's lifetime.
 * Rewriting any of them here is how a proxy silently breaks sign-in.
 */

/** Headers that describe this hop rather than the request being forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // The length of the body as this server received it. `content-length` is
  // forwarded as part of the body, so it is deliberately not dropped here, but a
  // chunked request has none and Node sets it itself.
  'content-length',
]);

/**
 * How long the backend has to answer before the request is given up on.
 *
 * Longer than the frontend's own client timeout, so a slow backend is reported by
 * this proxy as a gateway error rather than reaching the browser as a request that
 * was never sent. A free-tier backend can hold a cold start for the best part of a
 * minute.
 */
const UPSTREAM_TIMEOUT_MS = 95_000;

/** Reads the API origin from the environment, with a sensible local default. */
export function apiOrigin(env: NodeJS.ProcessEnv = process.env): URL {
  const configured = env['API_ORIGIN']?.trim();

  if (!configured) {
    return new URL('http://127.0.0.1:8099');
  }

  let parsed: URL;

  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(
      `API_ORIGIN is not a URL: ${JSON.stringify(configured)}. ` +
        'It has to be the backend origin, including the scheme, e.g. ' +
        'https://knowledge-assistant-backend.onrender.com',
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`API_ORIGIN has to be http or https, not ${parsed.protocol}`);
  }

  return parsed;
}

/**
 * Builds the handler that forwards `prefix` to the backend.
 *
 * `prefix` is matched against the *full* request path rather than used as an Express
 * mount point. `app.use('/api', handler)` rewrites `req.url` to what follows the
 * mount, so forwarding that sends `/auth/login` to a backend that routes on
 * `/api/auth/login`, and every call 404s — which reads as the API being down rather
 * than as a path being lost in the proxy.
 *
 * The query string is left exactly as it arrived, because routes read it.
 */
export function apiProxy(prefix: string, origin: URL): RequestHandler {
  const send = origin.protocol === 'https:' ? httpsRequest : httpRequest;
  const basePath = origin.pathname.replace(/\/$/, '');

  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => {
    const path = req.url ?? '/';

    if (path !== prefix && !path.startsWith(`${prefix}/`) && !path.startsWith(`${prefix}?`)) {
      next();

      return;
    }

    const headers: Record<string, string | string[]> = {};

    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) {
        continue;
      }

      headers[name] = value;
    }

    const upstream = send(
      {
        protocol: origin.protocol,
        hostname: origin.hostname,
        port: origin.port || (origin.protocol === 'https:' ? 443 : 80),
        method: req.method,
        // Taken apart and put back together rather than resolved through `URL`, so
        // that a path carrying its own encoded characters arrives encoded.
        path: `${basePath}${path}`,
        headers,
      },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);

        upstreamResponse.pipe(res);
      },
    );

    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstream.destroy(new Error('The backend took too long to answer'));
    });

    upstream.on('error', (error: Error) => {
      // `next` is the only way to hand this to Express's error handler; a response
      // already started cannot be written to, and there is nothing useful to say on
      // it in any case.
      if (res.headersSent) {
        res.destroy(error);

        return;
      }

      next(error);
    });

    // The body, streamed rather than buffered: a document upload goes through here
    // too, and buffering it would put the whole file in memory on both sides.
    req.pipe(upstream);
  };
}
