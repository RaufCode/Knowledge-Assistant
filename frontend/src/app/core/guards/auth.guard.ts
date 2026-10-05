import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';

import { AuthService } from '../services/auth.service';

/** The two answers a guard can give. `true` is let through, a tree is sent elsewhere. */
type Decision = boolean | UrlTree;

/**
 * Waits for the session to be known, then reports whether it is one.
 *
 * Awaited rather than read from the status, which starts as `unknown`. Treating that
 * as "not signed in" would send a signed-in person to the sign-in screen on every
 * reload, before the cookie had been checked.
 *
 * The service is resolved before the first `await` on purpose. `inject()` only works
 * synchronously inside the context a guard is called in, so reaching for it after a
 * pause has already lost that context and throws.
 */
async function hasSession(): Promise<boolean> {
  const auth = inject(AuthService);

  // A server render cannot answer this: the cookies are in the browser and a render
  // has neither them nor the answer. This is also what keeps a prerender from
  // blocking on a call that could not succeed.
  if (!auth.isBrowserOnly()) {
    return false;
  }

  // Asked through the hint-aware path, so a visitor with no session is told so
  // without a request. That matters most on the signed-out screens, where the
  // question is usually answered by the absence of a cookie.
  await auth.maybeBootstrap();

  return auth.isAuthenticated();
}

/**
 * The decision behind `authGuard`, shared with `adminGuard`.
 *
 * Not a guard itself, so it can be called without the route arguments the router
 * would supply. Sharing it is the point: "who is signed in" is one question, and two
 * copies of it could disagree.
 */
async function decideForAppRoutes(): Promise<Decision> {
  const auth = inject(AuthService);
  const router = inject(Router);

  // Deferred to the browser rather than guessed at on the server. Not a hole: every
  // route behind this fetches through `ApiService`, which only runs in a browser and
  // is refused with a 401 when the session is not there. What a server render can
  // produce is the shell, and it produces no company data.
  if (!auth.isBrowserOnly() || (await hasSession())) {
    return true;
  }

  // Where they were going is carried along, so signing in continues to where they
  // were heading rather than dropping them on the dashboard.
  return router.createUrlTree(['/login'], { queryParams: { returnUrl: router.url } });
}

/** Keeps signed-out visitors off the app's routes. */
export const authGuard: CanActivateFn = () => decideForAppRoutes();

/**
 * Keeps signed-in people away from the administrator screens.
 *
 * A non-administrator goes to the dashboard rather than to a refusal screen: there
 * is nothing for them to do on that route, and the dashboard is a shell they can
 * already use.
 *
 * Worth being plain about what this is: a convenience, not the boundary. The backend
 * refuses these same routes with a 403 for anybody whose role is not `admin`, so a
 * guard that was bypassed entirely would still not let an employee through.
 */
export const adminGuard: CanActivateFn = async () => {
  // Resolved before the await, for the same reason `hasSession` does it: `inject()`
  // does not work once the injection context has been left behind.
  const auth = inject(AuthService);
  const router = inject(Router);

  // Deferred to the browser, exactly as the session check is. A server render knows
  // nothing about the role — there is no user on the server at all — so evaluating
  // it here answers "not an administrator" for everybody, which is a redirect to
  // the dashboard on every full page load of an admin screen.
  //
  // Not a hole in the other direction either: a render cannot reach admin data,
  // because nothing on the server fetches it, and the moment the client takes over
  // this guard runs again with a real answer and sends a non-administrator away.
  if (!auth.isBrowserOnly()) {
    return true;
  }

  // The signed-out answer is taken from the shared decision rather than decided
  // again, so somebody signed out is sent to the sign-in screen instead of being
  // bounced to the dashboard first and arriving at the sign-in screen a moment later.
  const allowed = await decideForAppRoutes();

  if (allowed !== true) {
    return allowed;
  }

  return auth.isAdmin() ? true : router.createUrlTree(['/']);
};

/**
 * Keeps signed-in people away from the sign-in and accept-invite screens.
 *
 * The counterpart to `authGuard`: without it, a signed-in person following an old
 * invitation link lands on a form whose submission would replace the session they
 * already have.
 *
 * Only "is somebody signed in" is shared with the others. It does not use their
 * answer, because that answer is a redirect to the sign-in screen for somebody
 * already signed out, which is exactly the wrong direction here.
 *
 * Where an already-signed-in person is sent is their role's landing screen rather
 * than `/`, so an administrator following an old sign-in link arrives on the
 * dashboard instead of in a chat screen they would have to navigate out of.
 */
export const guestGuard: CanActivateFn = async () => {
  const router = inject(Router);

  // Resolved before the await, for the reason `hasSession` resolves `AuthService`
  // first: `inject()` does not work once the injection context has been left.
  const auth = inject(AuthService);

  return (await hasSession()) ? router.createUrlTree([auth.landingPath()]) : true;
};
