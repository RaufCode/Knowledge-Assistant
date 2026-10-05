import { vi } from 'vitest';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { CanActivateFn, Router, UrlTree, provideRouter } from '@angular/router';

import { API_BASE_URL } from '../api.config';
import { AuthService } from '../services/auth.service';
import { adminGuard, authGuard, guestGuard, landingGuard } from './auth.guard';

/** A stand-in route, which is all a `CanActivateFn` is given. */
const route = {} as never;
/** A stand-in router state, likewise. */
const state = {} as never;

describe('auth guards', () => {
  let http: HttpTestingController;
  let router: Router;

  /**
   * Runs a guard with the injector a navigation would give it.
   *
   * Guards are plain functions that reach for the injector, so they can only be
   * called inside one. This is the smallest thing that provides one, and passing
   * stand-ins for the route and the router state is enough: none of these guards
   * reads either.
   */
  const run = (guard: CanActivateFn) =>
    TestBed.runInInjectionContext(() => guard(route, state)) as Promise<boolean | UrlTree>;

  /**
   * The URL a guard redirected to.
   *
   * Asserts it redirected rather than casting: every caller of this is asking
   * "where did they send this person", and a `true` answer is a failure of the
   * thing being checked.
   */
  const redirectedTo = (allowed: boolean | UrlTree): string => {
    expect(allowed).toBeInstanceOf(UrlTree);

    return router.serializeUrl(allowed as UrlTree);
  };

  /** Sets the readable hint the guards use to decide whether asking is worthwhile. */
  const withSessionHint = (): void => {
    document.cookie = 'ika_session=1; path=/';
  };

  /**
   * Answers the `GET /api/auth/me` the guard asked for.
   *
   * Separate from setting the hint because the guard reads that synchronously, the
   * moment it starts: setting it and flushing afterwards would be too late, and the
   * guard would conclude there was no session and never ask.
   */
  const answerSession = (role: 'employee' | 'admin' | null): void => {
    if (role === null) {
      http
        .expectOne(`${API_BASE_URL}/api/auth/me`)
        .flush({ detail: 'Not authenticated' }, { status: 401, statusText: 'Unauthorized' });

      return;
    }

    http
      .expectOne(`${API_BASE_URL}/api/auth/me`)
      .flush({ id: 'u1', name: 'Ama Konadu', email: `ama@acmetech.example`, role });
  };

  beforeEach(async () => {
    // Cleared between tests: `document.cookie` outlives the injector, so a hint left
    // behind by one test would make the next one believe it had a session. The
    // remembered session in storage outlives it too, for the same reason.
    document.cookie = 'ika_session=; path=/; max-age=0';
    localStorage.clear();

    await TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', children: [] },
          { path: 'login', children: [] },
          { path: 'admin', canActivate: [adminGuard], children: [] },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();

    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  describe('authGuard', () => {
    it('lets a signed-in person through', async () => {
      withSessionHint();
      const result = run(authGuard);
      answerSession('employee');

      expect(await result).toBe(true);
    });

    it('sends a signed-out visitor to the sign-in screen, asking nobody', async () => {
      const result = run(authGuard);

      expect(redirectedTo(await result)).toContain('/login');
      http.verify();
    });

    it('remembers where they were going, so signing in can continue', async () => {
      await router.navigate(['/']);
      const result = run(authGuard);

      const allowed = await result;

      // Without this a guard would send everybody to the dashboard, and following a
      // deep link would end in the wrong place after signing in.
      expect(redirectedTo(allowed)).toContain('returnUrl');
    });

    it('still redirects, rather than failing, when the backend cannot be reached', async () => {
      // A sleeping backend is not a signed-out visitor. The guard cannot answer,
      // so it falls back to the last known state instead of rejecting — a
      // rejection would leave the navigation hanging rather than landing anywhere.
      withSessionHint();
      const result = run(authGuard);

      http.expectOne(`${API_BASE_URL}/api/auth/me`).error(new ProgressEvent('error'));
      http.expectOne(`${API_BASE_URL}/api/auth/refresh`).error(new ProgressEvent('error'));

      expect(redirectedTo(await result)).toContain('/login');
    });

    it('lets a restored session through without waiting for the network', async () => {
      // The bug this covers: on a refresh the app knew nobody until `/me`
      // answered, so the sign-in screen could be shown for a frame before the real
      // page arrived. The snapshot makes the answer available before the first
      // render, so the guard answers immediately and `/me` only confirms it.
      localStorage.setItem(
        'knowledge-assistant.user',
        JSON.stringify({
          id: 'u1',
          name: 'Ama Konadu',
          email: 'ama@acmetech.example',
          role: 'employee',
        }),
      );

      const result = run(authGuard);

      // Settled without anything being answered first.
      expect(await result).toBe(true);

      // The revalidation is still on its way, and the CSRF token that follows it.
      await new Promise((resolve) => setTimeout(resolve, 10));
      http.expectOne(`${API_BASE_URL}/api/auth/me`).flush({
        id: 'u1',
        name: 'Ama Konadu',
        email: 'ama@acmetech.example',
        role: 'employee',
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      http.expectOne(`${API_BASE_URL}/api/auth/csrf`).flush({ csrf_token: 'a-token' });
      http.verify();
    });

    it('sends a restored session to the sign-in screen once it is confirmed gone', async () => {
      // The counterpart: letting the guard through early must not leave a dead
      // session on a page that can load nothing. Reaching sign-in without a flash
      // of the app is the whole behaviour.
      localStorage.setItem(
        'knowledge-assistant.user',
        JSON.stringify({
          id: 'u1',
          name: 'Ama Konadu',
          email: 'ama@acmetech.example',
          role: 'employee',
        }),
      );

      const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

      expect(await run(authGuard)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 10));
      http
        .expectOne(`${API_BASE_URL}/api/auth/me`)
        .flush({ detail: 'Not authenticated' }, { status: 401, statusText: 'Unauthorized' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      http
        .expectOne(`${API_BASE_URL}/api/auth/refresh`)
        .flush({ detail: 'No active session.' }, { status: 401, statusText: 'Unauthorized' });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(navigate).toHaveBeenCalled();
      expect(TestBed.inject(AuthService).isAuthenticated()).toBe(false);
    });

    it('asks only once however many guards run', async () => {
      withSessionHint();
      const first = run(authGuard);
      const second = run(authGuard);

      answerSession('employee');

      expect(await first).toBe(true);
      expect(await second).toBe(true);

      // One request, not two: a second call would be a second chance for the cookie
      // to have expired in between, and the two answers could disagree. Matching on
      // the exact criteria is what proves it — `verify` would also flag the CSRF
      // request a successful bootstrap fires on its way out.
      http.expectNone(`${API_BASE_URL}/api/auth/me`);

      // The one request that was made is answered, so nothing is left open.
      await new Promise((resolve) => setTimeout(resolve, 10));
      http
        .match(`${API_BASE_URL}/api/auth/csrf`)
        .forEach((request) => request.flush({ csrf_token: 't' }));
      http.verify();
    });
  });

  describe('adminGuard', () => {
    it('lets an administrator through', async () => {
      withSessionHint();
      const result = run(adminGuard);
      answerSession('admin');

      expect(await result).toBe(true);
    });

    it('sends an employee to the dashboard rather than to an admin screen', async () => {
      withSessionHint();
      const result = run(adminGuard);
      answerSession('employee');

      expect(redirectedTo(await result)).toBe('/');
    });

    it('sends a signed-out visitor to the sign-in screen, not the dashboard', async () => {
      const result = run(adminGuard);

      // The signed-out answer has to win. Sending them to the dashboard first would
      // bounce them to the sign-in screen a moment later, having shown them a route
      // they cannot use.
      expect(redirectedTo(await result)).toContain('/login');
    });
  });

  describe('guestGuard', () => {
    it('lets a signed-out visitor reach the sign-in screen without asking who they are', async () => {
      // No hint cookie, so no request at all. This is the whole point: the sign-in
      // screen must not ask the backend for the user details of somebody who has not
      // signed in, and must not log a 401 for the privilege.
      const result = run(guestGuard);

      expect(await result).toBe(true);
      http.verify();
    });

    it('sends a signed-out visitor to the sign-in screen without asking who they are', async () => {
      const result = run(authGuard);

      expect(redirectedTo(await result)).toContain('/login');
      http.verify();
    });

    it('still answers correctly when a hint cookie is present but the session is gone', async () => {
      // A stale hint is the case that matters: the cookie outlives a session revoked
      // elsewhere, so the answer has to come from the server rather than the flag.
      withSessionHint();

      const result = run(guestGuard);
      http
        .expectOne(`${API_BASE_URL}/api/auth/me`)
        .flush({ detail: 'Not authenticated' }, { status: 401, statusText: 'Unauthorized' });

      // And the refresh that follows, refused. A 401 on `/me` is not on its own the
      // end of a session: the access cookie is short-lived and the refresh cookie
      // outlives it, so one refresh is tried before the answer is signed out.
      http
        .expectOne(`${API_BASE_URL}/api/auth/refresh`)
        .flush({ detail: 'Not authenticated' }, { status: 401, statusText: 'Unauthorized' });

      expect(await result).toBe(true);
    });

    it('does ask when the hint says there might be a session', async () => {
      withSessionHint();

      const result = run(guestGuard);
      http
        .expectOne(`${API_BASE_URL}/api/auth/me`)
        .flush({ id: 'u1', name: 'Ama', email: 'ama@acmetech.example', role: 'employee' });

      // And a signed-in person is kept off the sign-in screen.
      expect(await result).toBeInstanceOf(UrlTree);
    });

    it('sends a signed-in person away, so an old invitation link cannot replace their session', async () => {
      withSessionHint();
      const result = run(guestGuard);
      answerSession('employee');

      expect(await result).toBeInstanceOf(UrlTree);
    });

    it('sends an employee who is already signed in to the assistant', async () => {
      withSessionHint();
      const result = run(guestGuard);
      answerSession('employee');

      expect(redirectedTo(await result)).toBe('/');
    });

    it('sends an administrator who is already signed in to the dashboard', async () => {
      withSessionHint();
      const result = run(guestGuard);
      answerSession('admin');

      // The same stale sign-in link, for the other role. Sending both to `/` would
      // drop the administrator into a chat screen they have to navigate out of, which
      // is the thing this rule exists to prevent.
      expect(redirectedTo(await result)).toBe('/admin');
    });
  });

  describe('landingGuard', () => {
    it('sends an administrator arriving at the front door to the dashboard', async () => {
      withSessionHint();
      const result = run(landingGuard);
      answerSession('admin');

      // The dashboard is where an administrator's work is, and the chat screen is
      // not what they came for.
      expect(redirectedTo(await result)).toBe('/admin');
    });

    it('lets an employee through to the assistant', async () => {
      withSessionHint();
      const result = run(landingGuard);
      answerSession('employee');

      // Only administrators are redirected. An employee has nothing else to land on.
      expect(await result).toBe(true);
    });

    it('sends a signed-out visitor to the sign-in screen, not to the dashboard', async () => {
      // The session check is taken from the shared decision, so somebody signed out
      // is not bounced to the dashboard first and arrives at the sign-in screen a
      // moment later.
      const result = run(landingGuard);

      expect(redirectedTo(await result)).toContain('/login');
    });
  });

  describe('during a server render', () => {
    /**
     * Re-registers the service as one that says it is not in a browser.
     *
     * The real service reports that from `PLATFORM_ID`, and overriding it after the
     * module is built is the only way to reach the server-side branch from a test
     * running in a browser. Worth having explicitly: that branch is where a role
     * check that could not be answered used to redirect every admin screen away.
     */
    const asServerRender = (): void => {
      const auth = TestBed.inject(AuthService) as unknown as { isBrowserOnly: () => boolean };

      auth.isBrowserOnly = () => false;
    };

    it('lets an admin-only route through rather than guessing the role', async () => {
      asServerRender();

      // No user exists on the server, so a guard that asked would read "not an
      // administrator" for everybody and send every admin deep link to the dashboard.
      expect(await run(adminGuard)).toBe(true);
    });

    it('lets an app route through rather than guessing the session', async () => {
      asServerRender();

      expect(await run(authGuard)).toBe(true);
      http.expectNone(`${API_BASE_URL}/api/auth/me`);
    });

    it('lets the front door through rather than guessing the role', async () => {
      asServerRender();

      // A render knows nobody's role. Redirecting here would send every
      // administrator to the dashboard before the client had taken over at all.
      expect(await run(landingGuard)).toBe(true);
      http.expectNone(`${API_BASE_URL}/api/auth/me`);
    });

    it('lets a signed-out visitor reach the sign-in screen', async () => {
      asServerRender();

      expect(await run(guestGuard)).toBe(true);
      http.expectNone(`${API_BASE_URL}/api/auth/me`);
    });

    it('asks nothing at all, because there are no cookies to judge by', async () => {
      // A render has no cookies and no `document`, so the hint cannot be read and the
      // answer cannot be had. Nothing is requested rather than something guessed at.
      asServerRender();

      expect(await run(guestGuard)).toBe(true);
      http.verify();
    });
  });

  it('reports who is signed in from the answer rather than from a token', async () => {
    withSessionHint();
    run(authGuard);
    answerSession('admin');

    await TestBed.inject(AuthService).bootstrap();

    const auth = TestBed.inject(AuthService);

    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.isAdmin()).toBe(true);
    expect(auth.user()?.name).toBe('Ama Konadu');
  });
});
