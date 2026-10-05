import { describe, expect, it } from 'vitest';

import { API_BASE_URL } from './api.config';

describe('API_BASE_URL', () => {
  it('is the app\'s own origin, so every API call is same-origin', () => {
    // THE invariant behind "it works on a phone as well as a laptop".
    //
    // The session is two `httpOnly` cookies, and whether the browser attaches them
    // to an API call is decided from the site that call goes to — not by this app.
    // Pointing at an absolute origin puts that decision in the browser's hands
    // again: Safari and Chrome apply their third-party cookie policies to it, and
    // `SameSite` withholds the cookies from any cross-site `fetch`. The failure is
    // indistinguishable from a wrong password — sign-in answers 200, stores the
    // cookies, and the next call answers 401 — and it varies by browser and device
    // rather than by anything in the code, which is what made it so hard to pin
    // down from the outside.
    //
    // Empty means the requests are built from a relative path, so they go to
    // whichever address the app was opened at: `localhost`, `127.0.0.1`, a phone
    // on the same wifi, or the deployed domain. The API is reached through the
    // `/api` reverse proxy in `src/server.ts`, or the dev-server proxy.
    expect(API_BASE_URL).toBe('');
  });

  it('builds same-origin request paths from it', () => {
    // What `ApiService` does with an empty base: a rooted path, which the browser
    // resolves against the current origin.
    expect(`${API_BASE_URL}/api/auth/login`).toBe('/api/auth/login');
    expect(`${API_BASE_URL}/api/conversations/abc/messages`).toBe(
      '/api/conversations/abc/messages',
    );
  });
});
