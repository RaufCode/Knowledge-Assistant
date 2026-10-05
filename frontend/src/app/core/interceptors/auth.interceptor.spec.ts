import { vi } from 'vitest';

import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { API_BASE_URL } from '../api.config';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from '../services/auth.service';

/** Writes a cookie the way the backend's `Set-Cookie` would. */
const setCsrfCookie = (value: string): void => {
  document.cookie = `ika_csrf=${value}; path=/`;
};

/**
 * Lets queued continuations run.
 *
 * `refresh()` resolves through a promise rather than an observable, and the replay
 * is only issued once it has. Waiting one macrotask is not always enough for that
 * chain to finish, so this is deliberately longer than a tick rather than exactly
 * one: a test that passes by a hair is a test that will fail again on a slower
 * machine.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe('authInterceptor', () => {
  let http: HttpTestingController;
  let router: Router;
  let client: HttpClient;

  beforeEach(async () => {
    // Cleared between tests, because `document.cookie` outlives the injector and a
    // token left behind by one test would silently satisfy the next one's assertion.
    // The remembered session in storage outlives it too, for the same reason.
    document.cookie = 'ika_csrf=; path=/; max-age=0';
    localStorage.clear();

    await TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'login', children: [] }]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();

    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    client = TestBed.inject(HttpClient);
  });

  it('refreshes a rotated token and sends the request once more', async () => {
    // The cookie is replaced server-side whenever the session changes, so a token read
    // before signing in is stale and the browser pairs a new cookie with an old header.
    // The server cannot tell that from a forged request, so the tab recovers: refresh,
    // wait for the new cookie, try again. Once.
    setCsrfCookie('stale-token');
    client.post(`${API_BASE_URL}/api/conversations`, {}).subscribe();

    const first = http.expectOne(`${API_BASE_URL}/api/conversations`);
    expect(first.request.headers.get('X-CSRF-Token')).toBe('stale-token');

    // The browser's cookie is replaced when the refresh lands.
    first.flush(
      { detail: 'This request is missing a valid CSRF token.' },
      { status: 403, statusText: 'Forbidden' },
    );

    // The browser stores the new cookie as the refresh lands. Set before flushing,
    // because that is the moment it happens, and the retry reads it on the far side.
    setCsrfCookie('fresh-token');
    http.expectOne(`${API_BASE_URL}/api/auth/csrf`).flush({ csrf_token: 'fresh-token' });

    const retry = http.expectOne(`${API_BASE_URL}/api/conversations`);

    // The new value, which is only knowable after the refresh completed. Reading the
    // cookie as soon as the refresh was fired gets the one that was just refused.
    expect(retry.request.headers.get('X-CSRF-Token')).toBe('fresh-token');
    retry.flush({ id: 'c1' });
  });

  it('does not retry a 403 that is about permission rather than the token', () => {
    // An employee reaching an administrator's route must get one refusal, not two
    // attempts — and a request with a side effect must never be repeated on a
    // refusal that has nothing to do with the token.
    setCsrfCookie('token-from-the-cookie');
    client.post(`${API_BASE_URL}/api/auth/users`, {}).subscribe({ error: () => undefined });

    const request = http.expectOne(`${API_BASE_URL}/api/auth/users`);
    request.flush({ detail: 'Not an administrator.' }, { status: 403, statusText: 'Forbidden' });

    http.expectNone(`${API_BASE_URL}/api/auth/csrf`);
    http.expectNone(`${API_BASE_URL}/api/auth/users`);
  });

  it('puts the CSRF token on a state-changing request', () => {
    setCsrfCookie('token-from-the-cookie');
    client.post(`${API_BASE_URL}/api/conversations`, {}).subscribe();

    const request = http.expectOne(`${API_BASE_URL}/api/conversations`);

    // Read out of the cookie the server set, and echoed back as a header. A
    // cross-origin attacker can cause the cookie to be sent but cannot read it, so
    // cannot produce this header.
    expect(request.request.headers.get('X-CSRF-Token')).toBe('token-from-the-cookie');

    request.flush({});
  });

  it('leaves a read alone', () => {
    setCsrfCookie('token-from-the-cookie');
    client.get(`${API_BASE_URL}/api/auth/me`).subscribe();

    const request = http.expectOne(`${API_BASE_URL}/api/auth/me`);

    // A header on a GET would be noise, and the server ignores it there.
    expect(request.request.headers.has('X-CSRF-Token')).toBe(false);

    request.flush({});
  });

  it('leaves the sign-in call alone, since there is no session to have issued a token', () => {
    setCsrfCookie('token-from-the-cookie');
    client.post(`${API_BASE_URL}/api/auth/login`, {}).subscribe();

    const request = http.expectOne(`${API_BASE_URL}/api/auth/login`);

    expect(request.request.headers.has('X-CSRF-Token')).toBe(false);

    request.flush({});
  });

  /**
   * Puts the service into a state where a 401 means "the access token ran out".
   *
   * Answering `GET /api/auth/me` with a user is what does it: that is the only way
   * a session is ever established, and the interceptor's decision to refresh turns
   * on the service knowing about one.
   */
  const establishSession = async (): Promise<void> => {
    const promise = TestBed.inject(AuthService).bootstrap();

    http
      .expectOne(`${API_BASE_URL}/api/auth/me`)
      .flush({ id: 'u1', name: 'Ama Konadu', email: 'ama@acmetech.example', role: 'employee' });
    await promise;

    // The CSRF token is fetched just after the session is established rather than
    // during it, so it has not been asked for yet at the moment the answer above
    // arrives.
    await settle();
    http.expectOne(`${API_BASE_URL}/api/auth/csrf`).flush({ csrf_token: 'token-from-the-cookie' });
  };

  it('refreshes once and replays the request after an expired access token', async () => {
    setCsrfCookie('token-before-refresh');
    await establishSession();

    let answer: unknown;
    client
      .get(`${API_BASE_URL}/api/conversations?client_id=1`)
      .subscribe((value) => (answer = value));

    // The access token has run out. That is the whole event this test is about.
    http
      .expectOne(`${API_BASE_URL}/api/conversations?client_id=1`)
      .flush({ detail: 'expired' }, { status: 401, statusText: 'Unauthorized' });

    // One refresh, and the rotated CSRF token with it.
    setCsrfCookie('token-after-refresh');
    http.expectOne(`${API_BASE_URL}/api/auth/refresh`).flush({
      user: { id: 'u1', name: 'Ama Konadu', email: 'ama@acmetech.example', role: 'employee' },
    });
    await settle();

    // The original request, sent again.
    const replayed = http.expectOne(`${API_BASE_URL}/api/conversations?client_id=1`);

    // The header has to be rebuilt from the cookie that arrived with the refresh. A
    // replay carrying the token the server has already replaced would be refused, so
    // the retry would fail for a reason that has nothing to do with the expiry.
    expect(replayed.request.headers.get('X-CSRF-Token')).toBe('token-after-refresh');

    replayed.flush({ conversations: [] });
    await settle();

    expect(answer).toEqual({ conversations: [] });
  });

  it('does not refresh again once it has already refreshed', async () => {
    setCsrfCookie('a-token');
    await establishSession();

    client
      .get(`${API_BASE_URL}/api/conversations?client_id=1`)
      .subscribe({ error: () => undefined });

    http
      .expectOne(`${API_BASE_URL}/api/conversations?client_id=1`)
      .flush({ detail: 'expired' }, { status: 401, statusText: 'Unauthorized' });
    http
      .expectOne(`${API_BASE_URL}/api/auth/refresh`)
      .flush({ user: { id: 'u1', name: 'Ama', email: 'a@acmetech.example', role: 'employee' } });
    await settle();

    // The replay is refused too, and this is the case the guard against a refresh
    // loop exists for. A second refresh would arrive after the first had rotated
    // the token, and the server would read that as a replayed token and revoke the
    // whole family — logging the user out for trying to use the app.
    http
      .expectOne(`${API_BASE_URL}/api/conversations?client_id=1`)
      .flush({ detail: 'expired again' }, { status: 401, statusText: 'Unauthorized' });
    await settle();

    // Nothing after that: the 401 on the replay is reported, not refreshed again.
    http.verify();
  });

  it('sends the user to the sign-in screen when the refresh is refused', async () => {
    setCsrfCookie('a-token');
    await establishSession();

    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    client
      .get(`${API_BASE_URL}/api/conversations?client_id=1`)
      .subscribe({ error: () => undefined });

    http
      .expectOne(`${API_BASE_URL}/api/conversations?client_id=1`)
      .flush({ detail: 'expired' }, { status: 401, statusText: 'Unauthorized' });
    http
      .expectOne(`${API_BASE_URL}/api/auth/refresh`)
      .flush({ detail: 'No active session.' }, { status: 401, statusText: 'Unauthorized' });
    await settle();

    // The session is over, so whatever was on screen belonged to it and is no
    // longer visible. Where they were going is carried along, so signing in
    // again continues there rather than dropping them on the dashboard.
    expect(navigate).toHaveBeenCalledWith(['/login'], { queryParams: { returnUrl: '/' } });
    expect(TestBed.inject(AuthService).isAuthenticated()).toBe(false);
  });

  it('does not sign out when the refresh never reached the backend', async () => {
    // A backend that is asleep or unreachable is not a session that ended. The
    // request fails transiently and the session stands, so the next attempt —
    // against a backend that has woken up since — can still refresh it.
    setCsrfCookie('a-token');
    await establishSession();

    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    let failure: unknown;
    client
      .get(`${API_BASE_URL}/api/conversations?client_id=1`)
      .subscribe({ error: (error: unknown) => (failure = error) });

    http
      .expectOne(`${API_BASE_URL}/api/conversations?client_id=1`)
      .flush({ detail: 'expired' }, { status: 401, statusText: 'Unauthorized' });
    http.expectOne(`${API_BASE_URL}/api/auth/refresh`).error(new ProgressEvent('error'));
    await settle();

    expect(navigate).not.toHaveBeenCalled();
    expect(TestBed.inject(AuthService).isAuthenticated()).toBe(true);
    expect(failure).toBeTruthy();
  });

  it('does not try to refresh a 401 from a request made while signed out', () => {
    setCsrfCookie('a-token');

    client.get(`${API_BASE_URL}/api/auth/me`).subscribe({ error: () => undefined });

    http
      .expectOne(`${API_BASE_URL}/api/auth/me`)
      .flush({ detail: 'Not authenticated' }, { status: 401, statusText: 'Unauthorized' });

    // Refreshing here would be refreshing a session that does not exist, and the
    // failure would be reported as though signing in had gone wrong.
    http.expectNone(`${API_BASE_URL}/api/auth/refresh`);
  });

  it('passes a 403 straight through, because refreshing would not help', () => {
    setCsrfCookie('a-token');

    client.post(`${API_BASE_URL}/api/auth/invite`, {}).subscribe({ error: () => undefined });

    http
      .expectOne(`${API_BASE_URL}/api/auth/invite`)
      .flush({ detail: 'administrator' }, { status: 403, statusText: 'Forbidden' });

    // A 403 is a decision about what this person may do, not a session that ran
    // out. Asking again would produce the same answer.
    http.expectNone(`${API_BASE_URL}/api/auth/refresh`);
  });

  it('passes a 500 straight through too', () => {
    setCsrfCookie('a-token');

    client
      .get(`${API_BASE_URL}/api/conversations?client_id=1`)
      .subscribe({ error: () => undefined });

    http
      .expectOne(`${API_BASE_URL}/api/conversations?client_id=1`)
      .flush({}, { status: 500, statusText: 'Server Error' });

    http.expectNone(`${API_BASE_URL}/api/auth/refresh`);
  });
});

