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

/**
 * Where the backend is, when nothing says otherwise.
 *
 * Port 8000, because that is what the rest of the project uses — the README, every
 * curl example and the backend's own Dockerfile. It used to say 8099, which was
 * what the frontend had hardcoded before the API moved behind this proxy; nothing
 * ever listened there, so the proxy pointed at a closed port and every call in the
 * app failed with nothing in particular to show for it.
 */
const DEFAULT_API_ORIGIN = 'http://127.0.0.1:8000';

/** Reads the API origin from the environment, with a sensible local default. */
export function apiOrigin(env: NodeJS.ProcessEnv = process.env): URL {
  const configured = env['API_ORIGIN']?.trim();

  if (!configured) {
    // Silently falling back to localhost is how a deployment ends up proxying to
    // itself and reporting every API call as a network error, with nothing in the
    // logs to connect the two. Said out loud, it is a one-line fix.
    if (env['NODE_ENV'] === 'production') {
      throw new Error(
        'API_ORIGIN is not set. This server serves /api itself, so it has to be told ' +
          'where the backend is — without it every request in the app fails. Set it to ' +
          "the backend's origin, e.g. https://your-backend.onrender.com",
      );
    }

    return new URL(DEFAULT_API_ORIGIN);
  }

  let parsed: URL;

  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(
      `API_ORIGIN is not a URL: ${JSON.stringify(configured)}. ` +
        'It has to be the backend origin, including the scheme, e.g. ' +
        'https://your-backend.onrender.com',
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

    // The browser's `Origin` is rewritten to the API's own, because a request that
    // arrived through this server is same-origin by construction — it came from a
    // page this server rendered.
    //
    // Forwarding it instead meant the backend's origin allow-list had to name every
    // address the app is ever opened at: the deployed hostname, `localhost`,
    // `127.0.0.1`, and a LAN address for a phone. Each one had to be spelled
    // exactly right, and any that was not produced a 403 on the first write, which
    // looks nothing like a missing setting. That is the same class of failure as
    // the cookie problem this proxy exists to solve, so it is solved the same way:
    // by not depending on it.
    //
    // What this does not weaken: the check that stops a forged request is the
    // double-submit CSRF token, and it does not depend on `Origin` at all. A page on
    // another site can make the browser send this request, but cannot read the
    // `ika_csrf` cookie to copy into a header — the cookies are `SameSite=Lax`, so
    // they are not attached to a cross-site write in the first place. The `Origin`
    // check remains in place for anything reaching the backend directly.
    headers['origin'] = origin.origin;

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
