import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';

import { apiProxy } from './server/api-proxy';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine({
  trustProxyHeaders: true,
});

/**
 * The API, served from this process under its own path.
 *
 * Mounted before everything else, including the static files, because `/api` is
 * the one prefix this server does not answer itself.
 *
 * This is what makes the session work on a phone as well as on a laptop, and in
 * every browser, and the reason is a cookie rather than a line of code: the
 * session is two `httpOnly` cookies, and whether the browser attaches them to an
 * API call is decided by the site the call goes to. Forwarded through here, every
 * call is same-site by construction, so no browser's third-party cookie policy and
 * no `SameSite` attribute can withhold them. Called directly on another origin,
 * the same app signs in on some devices and reports "this browser did not keep
 * the session" on others, depending only on how that browser treats cookies it
 * did not set itself.
 *
 * `API_ORIGIN` says where the backend is, and is only needed by this: the browser
 * calls the backend on its own origin by default, named in `config.json`. It is
 * resolved when a request needs it rather than here, because a deployment that does
 * not use the proxy has no reason to have it — and reading it at startup took the
 * whole app down with `API_ORIGIN is not set` on every request path, including the
 * sign-in screen.
 */
app.use(apiProxy('/api'));

/**
 * Serve static files from /browser
 *
 * Before anything else, and that ordering matters: the sign-in screen is itself an
 * application, so its bundle, its stylesheet and its fonts are all fetched from
 * here.
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Renders the app for every other request.
 *
 * No cookie check, and no redirect to the sign-in screen.
 *
 * There used to be one — any request without an `ika_access` cookie was redirected
 * to sign-in — and it could never pass: the cookies were set by the API on the
 * API's host while this server answered on the app's host, so the browser never
 * sent them here. Every refresh of a protected page therefore 302'd to sign-in, and
 * the client — whose credentialed `GET /me` had succeeded — bounced straight back.
 * That round trip was the "sign-in flashes before the real page" bug.
 *
 * The proxy above is what makes such a check possible again, since the cookies now
 * belong to this origin. It is still not here, because it would buy nothing: the
 * browser holds a token this process cannot validate, and a redirect decided here
 * would be a guess. Whether a session exists is settled in the browser by
 * `authGuard`/`guestGuard` against `GET /api/auth/me`, and every route behind them
 * is refused by the backend with 401/403 regardless of what this process renders. A
 * render here produces the shell and no company data, so serving it to a
 * signed-out visitor discloses nothing and a signed-in one never leaves the page
 * they asked for.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
