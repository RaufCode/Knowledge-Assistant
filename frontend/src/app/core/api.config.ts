/**
 * Single source for the backend origin. Every HTTP call is built from this
 * constant, so pointing the app at a different deployment is a one-line change.
 *
 * The backend serves CORS with a wildcard origin, so the browser calls it
 * directly and no dev-server proxy is involved.
 *
 * Paths are appended by `ApiService`, which builds them from this origin, so the
 * `/api` prefix that the routes live under is not part of it.
 *
 * THE HOST MUST MATCH THE ONE THE APP IS SERVED FROM, exactly.
 *
 * Not a style point. The session cookies are `SameSite=Lax`, and "site" is decided
 * by the host, so a page at `127.0.0.1:4201` calling `localhost:8099` is a
 * cross-site request and the browser will not attach the cookies to it — sign-in
 * then appears to succeed, the cookies are stored, and every subsequent call comes
 * back 401. The ports are irrelevant; `localhost` and `127.0.0.1` are different
 * hosts and that is enough. The same applies in production, where it decides
 * whether the deployed frontend and the deployed API are one site or two.
 *
 * For local work, use `127.0.0.1` rather than `localhost` on both sides: `ng serve`
 * only permits `127.0.0.1` by default, so a `localhost` page is refused with a 400
 * before any of this matters.
 */
// The deployed backend on Render. Both services are `*.onrender.com`, so they are
// the same site and the `SameSite=Lax` session cookies are attached; the backend
// reflects the origin because `ALLOWED_ORIGINS` is `*`, which is what makes a
// credentialed cross-origin response acceptable to the browser.
export const API_BASE_URL = 'https://knowledge-assistant-chatbot.onrender.com';

// Local development. The backend runs from `backend/` with
// `uvicorn app.main:app --host 127.0.0.1 --port 8099`, and its ALLOWED_ORIGINS
// lists http://localhost:4200. Swap the two lines above to move between them:
//
//   export const API_BASE_URL = 'http://localhost:8099';

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
