import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, catchError, from, switchMap, throwError } from 'rxjs';

import { AuthService, CSRF_HEADER } from '../services/auth.service';

/** Requests that never carry a CSRF header, because they change nothing. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The auth routes the interceptor keeps its hands off.
 *
 * They are already past the session wall — a sign-in form and a 401 handler that
 * each waited on the other would deadlock — and the ones that change state are rate
 * limited and origin-checked on the server instead.
 */
const EXEMPT_PATHS = [
  '/api/auth/login',
  '/api/auth/accept-invite',
  '/api/auth/refresh',
  '/api/auth/csrf',
];

/**
 * Attaches the CSRF header, and handles an expired access token.
 *
 * Both jobs belong in one interceptor because both are about the same thing: the
 * session is a pair of cookies the app cannot see, so the app's only way to keep a
 * request working is to describe what it is doing in a way the server can check.
 *
 * The 401 path is the silent refresh. An access token lasts fifteen minutes and
 * nothing in this app can see when it ends, so instead of counting down to it the
 * interceptor treats the first 401 as a question — "can this session be extended?"
 * — and replays the request if it can. `AuthService.refresh()` shares one in-flight
 * refresh across every caller, so five requests failing at once produce one refresh
 * rather than five, which matters because the second one would arrive after the
 * first had already rotated the token and would be read as a replay.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  // Per request, not per interceptor: one tab sending several requests must not
  // consume another's single retry.
  let hasRetried = false;

  /** Whether this refusal is about the CSRF token rather than about permission. */
  const this_is_csrf_refusal = (error: HttpErrorResponse): boolean => {
    const detail = (error.error as { detail?: unknown } | null)?.detail;

    return typeof detail === 'string' && detail.includes('CSRF token');
  };

  const isExempt = EXEMPT_PATHS.some((path) => request.url.includes(path));
  const withHeader =
    SAFE_METHODS.has(request.method) || isExempt
      ? request
      : request.clone({ setHeaders: { [CSRF_HEADER]: auth.readCsrfToken() ?? '' } });

  return next(withHeader).pipe(
    catchError((error: unknown) => {
      // A CSRF token the server has already rotated away, retried once with a fresh
      // one.
      //
      // The cookie is replaced server-side whenever the session changes — signing in,
      // accepting an invitation, registering — so a token read before any of those is
      // stale, and the browser sends the new cookie with a header holding the old
      // value. The two disagree and the server refuses, which is the correct thing to
      // do: it cannot tell a stale tab from a forged request.
      //
      // So the tab refreshes and tries again. Once, and only for this exact refusal:
      // a retried request must never repeat a side effect, and a 403 about anything
      // else — an employee reaching an administrator's route — is not this problem
      // and must not be turned into a second attempt.
      if (
        error instanceof HttpErrorResponse &&
        error.status === 403 &&
        this_is_csrf_refusal(error) &&
        !hasRetried
      ) {
        hasRetried = true;

        // Waiting for the refresh before reading the cookie. Reading it as soon as
        // the request was fired gets the value that was just refused, which fails
        // again for exactly the same reason and looks like the fix doing nothing.
        return auth.refreshCsrfToken().pipe(
          switchMap(() =>
            next(request.clone({ setHeaders: { [CSRF_HEADER]: auth.readCsrfToken() ?? '' } })),
          ),
        );
      }

      if (!(error instanceof HttpErrorResponse) || error.status !== 401) {
        return throwError(() => error);
      }

      // Already on a way out, or on a screen that has no session yet. Retrying would
      // refresh a session that does not exist and then bounce the user to a page
      // they are already on.
      if (isExempt || !auth.isAuthenticated()) {
        return throwError(() => error);
      }

      // `refresh()` is a promise and shares one in-flight refresh, so this is one
      // refresh however many requests failed at the same moment.
      return from(auth.refresh()).pipe(
        switchMap((user) =>
          user
            ? next(withHeader.clone({ setHeaders: authHeaders(auth) }))
            : // The refresh was refused, so the session is genuinely over. Whatever
              // was on screen belonged to it and is no longer visible.
              endSession(auth, router, error),
        ),
      );
    }),
  );
};

/**
 * The headers for a replayed request.
 *
 * The session cookie the browser now holds is attached automatically, but the CSRF
 * token changed along with it, so the stale one the request was first built with
 * would be refused. Reading it back here is what makes a replay work.
 */
function authHeaders(auth: AuthService): Record<string, string> {
  return { [CSRF_HEADER]: auth.readCsrfToken() ?? '' };
}

/** Forgets the user and sends them to the sign-in screen. */
function endSession(auth: AuthService, router: Router, error: unknown): Observable<never> {
  auth.clear();

  // Where they were going is carried along, so signing in again continues to
  // where they were heading rather than dropping them on the dashboard.
  void router.navigate(['/login'], { queryParams: { returnUrl: router.url } });

  return throwError(() => error);
}
