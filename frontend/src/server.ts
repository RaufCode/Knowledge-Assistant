import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine({
  trustProxyHeaders: true,
});

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
 * No cookie check, and no redirect to the sign-in screen — deliberately. A previous
 * version redirected any request without an `ika_access` cookie, and that check
 * could never pass in production: the session cookies are set by the API on the
 * API's host, while this server answers on the app's host, so the browser never
 * sends them here. Every refresh of a protected page therefore 302'd to sign-in,
 * and the client — whose credentialed `GET /me` had succeeded — bounced straight
 * back. That round trip is the "sign-in flashes before the real page" bug.
 *
 * Nothing is given up by not checking. Whether a session exists is decided in the
 * browser by `authGuard`/`guestGuard` against `GET /api/auth/me`, and every route
 * behind them is refused by the backend with 401/403 regardless of what this
 * process renders. A render here produces the shell and no company data, so
 * serving it to a signed-out visitor discloses nothing and a signed-in one never
 * leaves the page they asked for.
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
