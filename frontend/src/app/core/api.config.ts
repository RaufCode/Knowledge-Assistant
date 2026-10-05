import { inject } from '@angular/core';

import { ConfigService } from './config.service';

/**
 * Single source for the backend origin. Every HTTP call is built from this, so
 * pointing the app at a different deployment is a one-line change.
 *
 * Empty, which means "the origin this page was served from". The API is reached
 * through the server that serves the app — the dev-server proxy in development
 * and the Express reverse proxy in production — so the browser is only ever making
 * same-origin requests.
 *
 * THAT IS THE POINT, and it is worth understanding before changing it.
 *
 * The session is two `httpOnly` cookies. Whether the browser attaches them to an
 * API call is decided by the browser, from the *site* the call goes to, and not by
 * anything this app does. Call the API from its own origin and every browser
 * treats the cookies as first-party, with no third-party cookie policy and no
 * `SameSite` attribute able to withhold them. Call it from another origin and each
 * browser applies its own rules: Safari and Chrome block or partition third-party
 * cookies, and `SameSite=Lax` withholds the cookies from every cross-site `fetch`.
 *
 * The failure is indistinguishable from a broken password. The sign-in request
 * returns 200, the cookies are stored, and the very next call answers 401 — so the
 * app reports "you signed in, but this browser did not keep the session". It comes
 * and goes with the browser and the device rather than with the code: working on a
 * laptop, failing on a phone, working in one browser and not the next, and
 * changing if you type `localhost` where you meant `127.0.0.1`, because those are
 * different sites.
 *
 * Setting this to an absolute URL puts that back. Do it only for a deployment that
 * genuinely cannot serve the API itself, and then the cookies need
 * `SameSite=None; Secure` (`AUTH_COOKIE_SAMESITE=none` on the backend) or sign-in
 * will not stick at all.
 *
 * `ConfigService` can override this at runtime from `config.json`, for a build that
 * has to point somewhere else without being rebuilt.
 */
export const API_BASE_URL = '';

/**
 * Returns the configured API base URL at runtime, or the default constant when
 * not in an injection context (e.g., during testing).
 */
export function getApiBaseUrl(): string {
  const config = inject(ConfigService, { optional: true });
  return config?.getApiBaseUrl() ?? API_BASE_URL;
}

/**
 * How long a single request may take before it is abandoned.
 *
 * Generous because the backend is on a free Render tier, where a cold start can
 * hold the first request for the best part of a minute. Below this a slow but
 * healthy answer would be reported as a failure the user can do nothing about.
 */
export const API_TIMEOUT_MS = 90_000;

/**
 * Where this browser's client id is kept, so its conversations are still its own
 * after a reload.
 *
 * `localStorage` rather than `sessionStorage` on purpose. The backend scopes
 * conversations to a client id and never expires them, so a conversation asked in
 * one tab is still there in the next one, and dropping the id when the tab closed
 * would strand every conversation this browser had.
 */
export const CLIENT_ID_STORAGE_KEY = 'ika.clientId';