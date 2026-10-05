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
 * The routes a signed-out visitor is allowed to be served.
 *
 * Everything else needs a session, so a request for it without one is answered with
 * the sign-in screen rather than with the page. `/register` is here because it is a
 * redirect to `/accept-invite` and answering it directly saves a hop.
 */
const SIGNED_OUT_ROUTES = new Set([
  '/login',
  '/accept-invite',
  '/register',
  '/pending-approval',
]);

/**
 * Serve static files from /browser
 *
 * Before the redirect below, and that ordering is load-bearing. The sign-in screen is
 * itself an application: its bundle, its stylesheet and its fonts are all fetched
 * from here. Redirecting a visitor with no session before this ran would answer
 * those requests with a 302 to `/login` and the sign-in screen would arrive with no
 * JavaScript at all.
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Sends a visitor with no session to the sign-in screen.
 *
 * Why this exists rather than leaving it to the route guards: a guard runs in the
 * browser, and by the time it has run the server has already answered with the
 * dashboard's markup. A signed-out visitor would see the app for a moment before
 * being redirected, which is the opposite of what "you have to sign in first" is
 * supposed to mean. Redirecting here means the first response to any protected URL
 * is the sign-in screen itself.
 *
 * Why the cookie is only checked for presence, and never verified: this process
 * cannot tell a valid session from a forged one. Verifying the token would mean
 * giving the frontend server the signing key, and anybody who could reach this
 * server could then mint a token for anyone. So this decides which *page* to send
 * and nothing more — it saves a redirect, it is not an authorization. A forged
 * cookie gets the app's empty shell, because every route behind it still refuses to
 * load any data and `authGuard` still sends the browser back to the sign-in screen
 * as soon as it runs.
 *
 * Where they were going is carried along, so signing in continues to that page
 * rather than dropping them on the dashboard.
 */
app.use((req, res, next) => {
  if (req.headers.cookie?.includes('ika_access=') || SIGNED_OUT_ROUTES.has(req.path)) {
    next();
    return;
  }

  res.redirect(302, `/login?returnUrl=${encodeURIComponent(req.originalUrl)}`);
});

/**
 * Handle all other requests by rendering the Angular application.
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
