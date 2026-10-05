import { inject } from '@angular/core';

import { ConfigService } from './config.service';

/**
 * Single source for the backend origin. Every HTTP call is built from this, so
 * pointing the app at a different deployment is a one-line change.
 *
 * Empty, which means "the origin this page was served from" — so the API is
 * reached through the server that serves the app. That is right for a deployment
 * that can serve its own API, and it is not what this one does: the browser calls
 * the backend on its own origin, which `public/config.json` names.
 *
 * WHY THAT MATTERS, because it is the cause of a failure that looks like a wrong
 * password.
 *
 * The session is two `httpOnly` cookies, and the backend marks them `Secure` in
 * production. A browser will not store a `Secure` cookie for a page served over
 * plain http, and it drops it without a word — the sign-in request still answers
 * `200`, and the next call answers `401`. So running this app locally over http
 * against a production backend cannot keep a session, on any device. Use the
 * deployed app for the deployed backend, or run the backend locally too, which
 * serves its cookies without `Secure`.
 *
 * The other half of it is `SameSite`. Cookies are attached based on the *site* a
 * request goes to, not the origin, and the ports are irrelevant — which is why
 * `localhost` and `127.0.0.1` are different sites but
 * `knowledge-assistant-chatbot.onrender.com` and any other `*.onrender.com` are
 * the same one. Same site is what lets `SameSite=Lax` work, and `Lax` is what
 * keeps the cookies first-party instead of third-party, which is what Safari and
 * Chrome are increasingly unwilling to send.
 *
 * Set this to an absolute URL only when the API really is elsewhere, and check
 * that it is the same *site* — same registrable domain — or the cookies will not
 * survive it on a phone.
 *
 * `ConfigService` overrides it at runtime from `config.json`, which is how the
 * deployed build names its backend without being rebuilt.
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
