import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { API_BASE_URL } from '../api.config';
import { AuthService } from './auth.service';

const ME = `${API_BASE_URL}/api/auth/me`;

describe('AuthService', () => {
  let auth: AuthService;
  let http: HttpTestingController;

  /** The readable flag the backend sets beside the session cookies. */
  const withHint = (): void => {
    document.cookie = 'ika_session=1; path=/';
  };

  const answerWithUser = (role: 'employee' | 'admin'): void => {
    http.expectOne(ME).flush({ id: 'u1', name: 'Ama Konadu', email: 'ama@acmetech.example', role });
  };

  /**
   * Answers a 401 on `/me`, and the refresh that follows it.
   *
   * A 401 on `/me` no longer settles the question by itself. The access cookie is
   * deliberately short-lived and the refresh cookie outlives it, so one refresh is
   * tried before the session is called over — and it is that refresh, refused, that
   * finally means signed out and clears the hint cookie.
   */
  const answerWithNobody = (): void => {
    http
      .expectOne(ME)
      .flush({ detail: 'Not authenticated' }, { status: 401, statusText: 'Unauthorized' });

    http
      .expectOne(`${API_BASE_URL}/api/auth/refresh`)
      .flush({ detail: 'Not authenticated' }, { status: 401, statusText: 'Unauthorized' });
  };

  /**
   * Awaits a settled bootstrap and answers the CSRF token request that follows it.
   *
   * That request is made from a `.then()`, so it appears only after the promise has
   * resolved — not the moment `/me` is answered. It comes regardless of the answer:
   * a 401 means the sign-in screen is about to be shown and needs a token to submit,
   * so the token is issued either way and later requests need not wait for it.
   */
  const settle = async <T>(pending: Promise<T>): Promise<T> => {
    const settled = await pending;
    http.expectOne(`${API_BASE_URL}/api/auth/csrf`).flush({ csrf_token: 'test-token' });

    return settled;
  };

  beforeEach(async () => {
    // `document.cookie` outlives the injector, so a hint left by one test would make
    // the next one believe it had a session. The remembered session in storage
    // outlives it too, for the same reason.
    document.cookie = 'ika_session=; path=/; max-age=0';
    localStorage.clear();

    await TestBed.configureTestingModule({
      providers: [provideHttpClientTesting()],
    });

    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  describe('looksSignedIn', () => {
    it('is false, and asks nobody, when there is no hint cookie', () => {
      expect(auth.looksSignedIn()).toBe(false);
    });

    it('is true when the hint cookie is there', () => {
      withHint();

      expect(auth.looksSignedIn()).toBe(true);
    });

    it('is not fooled by a cookie whose name merely starts the same', () => {
      // A prefix match here would be a bug, not a tolerance: `ika_session_hint` is a
      // different cookie and must not imply a session.
      document.cookie = 'ika_session_hint=1; path=/';

      expect(auth.looksSignedIn()).toBe(false);
    });

    it('is not fooled by the CSRF cookie', () => {
      // Both cookies are readable, so this is the mistake worth guarding against.
      document.cookie = 'ika_csrf=abc123; path=/';

      expect(auth.looksSignedIn()).toBe(false);
    });

    it('does not care what the hint says, only that it is there', () => {
      // Deliberately: the value is never interpreted. Anything at all means "worth
      // asking", and the server has the last word either way.
      document.cookie = 'ika_session=anything-at-all; path=/';

      expect(auth.looksSignedIn()).toBe(true);
    });
  });

  describe('maybeBootstrap', () => {
    it('sends no request at all without a hint, and settles as anonymous', async () => {
      const user = await auth.maybeBootstrap();

      expect(user).toBeNull();
      expect(auth.status()).toBe('anonymous');
      expect(auth.isAuthenticated()).toBe(false);
      http.verify();
    });

    it('asks when the hint suggests there might be a session', async () => {
      withHint();

      const settled = auth.maybeBootstrap();
      answerWithUser('employee');

      // One request, not two: the hint licensed exactly one question.
      expect((await settle(settled))?.email).toBe('ama@acmetech.example');
      expect(auth.isAuthenticated()).toBe(true);
    });

    it('trusts the server over the hint when the session turns out to be gone', async () => {
      // A stale hint is the ordinary case after a session is revoked in another tab.
      // The flag says "ask"; it does not say "signed in".
      withHint();

      const settled = auth.maybeBootstrap();
      answerWithNobody();

      expect(await settle(settled)).toBeNull();
      expect(auth.status()).toBe('anonymous');
    });

    it('does not send a second request when something has already settled it', async () => {
      withHint();

      const first = auth.maybeBootstrap();
      answerWithUser('employee');
      await settle(first);

      // Already answered: asking again would be the app talking to itself.
      expect(await auth.maybeBootstrap()).not.toBeNull();
      http.verify();
    });

    it('does not re-ask once sign-in has already settled it', async () => {
      withHint();

      const signedIn = auth.maybeBootstrap();
      answerWithUser('employee');
      await settle(signedIn);

      // A navigation that follows sign-in must not go back to the API for something
      // this tab already knows, hint cookie or not.
      expect(await auth.maybeBootstrap()).not.toBeNull();
      http.verify();
    });
  });

  describe('bootstrap', () => {
    it('asks regardless of the hint, for callers that genuinely need the answer', async () => {
      // The deliberate asymmetry: `bootstrap` is the unconditional question, kept for
      // callers that must know rather than guess.
      const settled = auth.bootstrap();
      answerWithNobody();

      expect(await settle(settled)).toBeNull();
    });
  });

  describe('remembered session', () => {
    it('asks when a session was established here, even with no readable hint', async () => {
      // The hint cookie lives on the API's host, which frontend JavaScript can
      // never read on a cross-site deploy. The remembered flag lives on this
      // origin instead, so a reload still asks rather than concluding signed out.
      localStorage.setItem('knowledge-assistant.session', '1');

      const settled = auth.maybeBootstrap();
      answerWithUser('employee');

      expect((await settle(settled))?.email).toBe('ama@acmetech.example');
      expect(auth.isAuthenticated()).toBe(true);
    });

    it('forgets the session with the user, so a later visit asks nobody', async () => {
      // Models a reload after signing out on a cross-site deploy: no readable
      // hint cookie (there never is one across sites), only the remembered flag —
      // which signing out must have removed along with the user.
      localStorage.setItem('knowledge-assistant.session', '1');

      const signedIn = auth.maybeBootstrap();
      answerWithUser('employee');
      await settle(signedIn);

      auth.clear();

      expect(localStorage.getItem('knowledge-assistant.session')).toBeNull();
      expect(await auth.maybeBootstrap()).toBeNull();
      http.verify();
    });
  });

    describe('verifySession', () => {
    it('is true when the cookies round-trip', async () => {
      let proven: boolean | null = null;
      auth.verifySession().subscribe((value) => (proven = value));

      http.expectOne(ME).flush({ id: 'u1', name: 'Ama', email: 'a@acmetech.example', role: 'employee' });

      await Promise.resolve();
      expect(proven).toBe(true);
    });

    it('is false when the browser kept no session, without touching the user', async () => {
      // A pure check: it neither signs anybody in nor out, so the caller decides
      // what a missing session means on its own screen.
      let proven: boolean | null = null;
      auth.verifySession().subscribe((value) => (proven = value));

      http
        .expectOne(ME)
        .flush({ detail: 'Not authenticated' }, { status: 401, statusText: 'Unauthorized' });

      await Promise.resolve();
      expect(proven).toBe(false);
    });

    it('rethrows what never reached the backend', async () => {
      let failure: unknown;
      auth.verifySession().subscribe({ error: (error: unknown) => (failure = error) });

      http.expectOne(ME).error(new ProgressEvent('error'));

      await Promise.resolve();
      expect(failure).toBeTruthy();
    });
  });

  describe('refresh', () => {    /** A session, established the way a guard would find it. */
    const establish = async (): Promise<void> => {
      withHint();

      const signedIn = auth.maybeBootstrap();
      answerWithUser('employee');
      await settle(signedIn);
    };

    it('ends the session when the backend refuses it', async () => {
      await establish();

      const refused = auth.refresh();
      http
        .expectOne(`${API_BASE_URL}/api/auth/refresh`)
        .flush({ detail: 'No active session.' }, { status: 401, statusText: 'Unauthorized' });

      await expect(refused).resolves.toBeNull();
      expect(auth.isAuthenticated()).toBe(false);
    });

    it('rethrows what never reached the backend instead of signing out', async () => {
      // A backend that is asleep or unreachable has said nothing about the
      // session. Converting that silence into a logout signed people out for
      // trying to use the app while it was waking up.
      await establish();

      const pending = auth.refresh();
      http.expectOne(`${API_BASE_URL}/api/auth/refresh`).error(new ProgressEvent('error'));

      await expect(pending).rejects.toThrow();
      expect(auth.isAuthenticated()).toBe(true);
    });
  });
});
