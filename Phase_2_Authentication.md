# Phase 2 — Backend Authentication

This is the second phase of the Internal Knowledge Assistant. Phase 1 built the
question/answer surface and left authentication deliberately unwired: the login and
accept-invite screens existed as drawings and nothing collected a real password.
This document describes the backend that makes accounts real, and the frontend work
that connects the existing screens to it.

**Status: implemented and verified.** Every checklist line in §11 is an executable
assertion, in three layers:

| Layer | What it covers | How to run |
|---|---|---|
| `backend/tests/test_auth.py` | 73 tests over the HTTP contract, in-process | `cd backend && .venv/bin/python -m unittest tests.test_auth` |
| `backend/scripts/verify_auth_checklist.sh` | 36 checks against a running backend, as a real HTTP client | `cd backend && ./scripts/verify_auth_checklist.sh` |
| `frontend/scripts/verify_auth_e2e.mjs` | 62 checks in a real browser against a real backend | see the header of that file |

---

## 1. Decisions already taken (not reopened here)

| Decision | Value |
|---|---|
| Who may hold an account | Company employees only; the email domain is enforced server-side. |
| How accounts are created | Invite only. An administrator provisions a pending user and sends a single-use, time-limited invite link. There is no self-service registration. |
| Roles | Two: `employee` and `admin`. The wire values are the server's; the UI label stays "HR Administrator". |
| Token transport | `httpOnly` cookies only. Never a JSON body, never `localStorage`, never readable by frontend JavaScript. |
| Where the enforcement lives | The backend. Frontend validators are a UX convenience only. |

---

## 2. Libraries to be introduced, and why

| Library | Purpose | Justification |
|---|---|---|
| `python-jose` | JWT signing and verification | Explicitly sanctioned by the task. Hand-rolled JWT signing (`base64url` splitting, HMAC comparison, claim checks) is a well-known source of real vulnerabilities. Used for **signing/verification only** — no user model, no router, no framework. |
| `passlib[bcrypt]` + `bcrypt==4.0.1` | Password hashing | Sanctioned by the task. `bcrypt` 5.x is rejected by passlib 1.7.4 (its backend-detection probe raises `ValueError: password cannot be longer than 72 bytes`), so the pin is required, not cosmetic. `bcrypt<4.1` is pinned in `requirements.txt`. |
| `slowapi` | Rate limiting on `/api/auth/login` and `/api/auth/accept-invite` | Sanctioned by the task. It is a thin wrapper over `limits` with a FastAPI decorator; it brings no auth model of its own. |

Nothing else is added. No `fastapi-users`, no `authlib`, no ORM migration tool
(the schema is created with `Base.metadata.create_all`, matching Phase 1), no email
service (the invite link is logged and returned).

---

## 3. Database schema changes

Added to `backend/app/database.py` (three new tables; `conversations` and
`messages` are untouched).

### `users`

| Column | Type | Notes |
|---|---|---|
| `id` | `String(64)` PK | `uuid4().hex` |
| `email` | `String(255)` unique, indexed | Stored lowercased and trimmed; the login form lowercases before lookup. |
| `name` | `String(120)` | Sanitised at the Pydantic layer. |
| `role` | `String(16)` | `"employee"` or `"admin"`, constrained by a `CHECK` in the validator layer (`Literal` on the request model). |
| `password_hash` | `String(255)` | bcrypt. `NULL` while the account is still a pending invitation. |
| `is_active` | `Boolean` | `False` until a password is set. A pending row cannot log in. |
| `created_at`, `updated_at` | `DateTime(timezone=True)` | |

There is deliberately **no** `client_id` merge in this phase. Phase 1 scopes
conversations to an anonymous browser id; tying them to the user id is a separate
migration and is out of scope here. The signed-in identity is the auth boundary;
conversation ownership is unchanged.

### `invites`

| Column | Type | Notes |
|---|---|---|
| `token` | `String(64)` PK | 256 bits from `secrets.token_urlsafe`, single-use. |
| `user_id` | FK `users.id` ondelete `CASCADE` | The pending account this invite belongs to. |
| `invited_by` | FK `users.id`, nullable | The administrator who created it. |
| `expires_at` | `DateTime(timezone=True)` | 72 hours by default. |
| `used_at` | `DateTime(timezone=True)` nullable | Set when the password is accepted. |
| `created_at` | `DateTime(timezone=True)` | |

Re-inviting a pending user **rotates** the token: the previous, unopened invite
stops working, so only the newest link can create the account.

### `refresh_sessions`

The server-side half of refresh rotation. A refresh token is opaque to the client:
its `jti` is looked up here, and the JWT `sub`/`jti` pair is only a claim — this row
is what makes revocation possible.

| Column | Type | Notes |
|---|---|---|
| `id` | `String(64)` PK | Carried as the JWT `jti`. |
| `user_id` | FK `users.id` ondelete `CASCADE` | |
| `created_at` | `DateTime(timezone=True)` | |
| `expires_at` | `DateTime(timezone=True)` | |
| `rotated_at` | `DateTime(timezone=True)` nullable | Set when this token is exchanged. |
| `revoked_at` | `DateTime(timezone=True)` nullable | Set by logout, or by reuse detection across the whole family. |
| `family_id` | `String(64)`, indexed | Every token descended from one login shares it. Reuse revokes the family. |

---

## 4. Token and cookie strategy

### Signing

- HS256, one secret (`AUTH_SECRET_KEY`), used for both token types.
- `typ` claim distinguishes them (`"access"` / `"refresh"`), and each verifier
  rejects the wrong type, so an access token cannot be presented at
  `/api/auth/refresh`.
- `aud` = `AUTH_TOKEN_AUDIENCE`, `iss` = `AUTH_TOKEN_ISSUER`; both are required on
  verify.
- Verification passes `options={"require_exp": True, "require_sub": True,
  "verify_aud": True}` — no claim is optional.

### Access token

- Lifetime **15 minutes** (`ACCESS_TOKEN_TTL_SECONDS`).
- Claims: `sub` (user id), `role`, `typ="access"`, `jti`, `exp`, `iat`, `aud`, `iss`.
- Cookie: `ika_access`, `httpOnly=True`, `Secure` (configurable, see below),
  `SameSite=Lax`, `Path=/`, `max_age=900`.

### Refresh token

- Lifetime **14 days** (`REFRESH_TOKEN_TTL_SECONDS`, within the 7–30 day band).
- Claims: `sub`, `typ="refresh"`, `jti` (= `refresh_sessions.id`), `fam`,
  `exp`, `iat`, `aud`, `iss`.
- Cookie: `ika_refresh`, `httpOnly=True`, `Secure`, `SameSite=Lax`, `Path=/`,
  `max_age=14d`.

### Why `SameSite=Lax` and not `Strict`

`Strict` is the stronger default, but the invitation is delivered as a link the
recipient opens from their mail client, so the first navigation to the app is a
top-level cross-site GET. `Strict` would withhold the cookies on exactly that
first navigation. `Lax` keeps cookies off every cross-site sub-request (the CSRF
exposure `Strict` closes) while still allowing top-level navigation. Because the
app is cross-origin in development (`:4200` → `:8000`), the browser will drop
these cookies entirely regardless unless the CSRF header is present, so the
double-submit token below is the control that actually matters. Origin checking is
applied on top as a second layer.

### CSRF — double-submit cookie

- `GET /api/auth/csrf` issues a random token and sets it as
  `ika_csrf` — **not** `httpOnly`, because the frontend has to read it and send it
  back as `X-CSRF-Token`. It carries no authority on its own.
- Every state-changing request (`POST`, `PATCH`, `PUT`, `DELETE`) that is not in
  the exempt list must carry `X-CSRF-Token` matching the `ika_csrf` cookie.
  Comparison uses `hmac.compare_digest`.
- The token is **not** tied to the session. It is the standard double-submit
  pattern, and it is the correct choice here because the frontend and backend are
  on different origins/ports in development, which rules out relying on
  `SameSite` alone.
- Exempt: `POST /api/auth/login`, `POST /api/auth/accept-invite`,
  `POST /api/auth/refresh`, `POST /api/auth/logout`. These are reached precisely
  when there is no session yet, so no CSRF token can be issued for them; they are
  protected instead by the login/accept-invite rate limit, `SameSite=Lax` (which
  blocks cross-site POSTs), and the Origin check.
- `POST /api/auth/invite` is **not** exempt: it is an authenticated admin action.

### Refresh rotation and theft detection

1. `POST /api/auth/refresh` verifies the JWT, then loads `refresh_sessions` by `jti`.
2. Missing row, or `revoked_at` set → **reuse**. Log it, and revoke every session in
   the same `family_id`.
3. `rotated_at` already set (a token that has already been exchanged) → **reuse**,
   revoke the family, return 401.
4. Otherwise mark `rotated_at`, mint a new session row in the same family, and set
   both new cookies.

Because each rotation writes a new row and marks the old one, presenting a
superseded token is always detectable server-side — the client cannot tell the
difference between a lost cookie and a stolen one, and the safe response is to
revoke the family either way.

### Secure-cookie flag

`Secure` is on by default. `AUTH_COOKIE_SECURE=false` exists only for local `http`
development, and it must be set explicitly; there is no auto-detection from the
request, so a misconfigured deployment fails closed (browsers drop the cookies)
rather than silently serving them insecurely.

---

## 5. Endpoints

All request bodies are Pydantic models with explicit types, length bounds, and
`EmailStr` + a company-domain validator. The domain check lives in the validator,
so a non-company address is a 422 before any lookup or password work happens.

### `POST /api/auth/csrf`
No body. `200 { "csrf_token": "..." }`, sets the readable `ika_csrf` cookie.

### `POST /api/auth/invite` — admin only
Request:
```json
{ "name": "Ama Konadu", "email": "ama.konadu@acmetech.example", "role": "employee" }
```
- `name`: 1–120 chars, stripped and control characters removed.
- `email`: `EmailStr`, must end with the configured company domain.
- `role`: `Literal["employee", "admin"]`.

Responses:
- `201 { "invite_link": ".../accept-invite?token=...", "expires_at": "...", "user": {...} }`
- `403` when the caller is not an admin (dependency).
- `409` when the address already has an active account.

Email sending is mocked: the link is logged and returned so an administrator can
pass it on. That is stated in the response rather than implied to have been mailed.

### `GET /api/auth/invite/{token}` — no auth
`200 { "name": "...", "email": "...", "role": "employee", "expires_at": "..." }`
so the accept-invite screen can pre-fill itself. Unknown, expired or already-used
tokens all answer `404 {"detail": "This invitation is not valid."}` — one message,
so a caller cannot probe which single condition failed.

### `POST /api/auth/accept-invite` — rate limited
Request: `{ "token": "...", "password": "..." }`
- `token`: 16–64 chars.
- `password`: 6–128 chars, no character-class requirements.

Response: `200 { "user": { "id", "name", "email", "role" } }` and both cookies are
set, so accepting an invitation signs the person straight in. The invite is marked
used, the password is hashed, the account is activated.

### `POST /api/auth/login` — rate limited
Request: `{ "email": "...", "password": "..." }` (company domain enforced).

Response: `200 { "user": {...} }` plus both cookies. `401` with a single message
for "no such user", "wrong password", and "account still pending" — the response
must not tell an attacker which of the three it was.

### `POST /api/auth/refresh`
No body. Reads the refresh cookie, rotates, sets both cookies,
`200 { "user": {...} }`. `401` on expiry, malformed token, or reuse detection.

### `POST /api/auth/logout`
Revokes the presented refresh session and its family, clears both cookies
(`max_age=0`), `200 { "status": "signed_out" }`.

### `GET /api/auth/me`
`200 { "id", "name", "email", "role" }` from the access cookie. `401` when the
access token is missing, expired or invalid. Used by the frontend on app load.

### `POST /api/auth/bootstrap-admin` — the one exception, and why
`{"bootstrap_key": "...", "name": "...", "email": "...", "password": "..."}`
creates the **first** administrator. It only works while zero admins exist, it
additionally requires a secret compared against `AUTH_BOOTSTRAP_KEY`, and it is
rate limited like login. This exists because an invite-only system otherwise has a
cold-start deadlock: nobody can invite the first administrator. It is not
registration — it cannot create a second admin, and it cannot create a non-admin.
A CLI (`python -m app.bootstrap_admin`) is the equivalent offline path and is the
preferred one; the endpoint is documented as emergency-only.

**No `register` endpoint, and `/register` is removed from the frontend routes.**
It will be replaced by a redirect to `/accept-invite`, since leaving a live
"Create your account" screen next to a backend that cannot honour it is worse
than removing it.

---

## 6. Dependencies and guards

In `backend/app/dependencies.py`:

- `get_current_user(request, db)` — reads the `ika_access` cookie, verifies it,
  loads the user, rejects `is_active=False`. Raises `401` otherwise. Never falls
  back to a header or a body, so a token cannot be exfiltrated into a log or a
  referrer.
- `require_admin(current_user = Depends(get_current_user))` — `403` unless
  `role == "admin"`.

Applied as follows:

| Route | Guard |
|---|---|
| `GET /health`, `GET /documents`, `GET /api/auth/*`, `POST /api/auth/bootstrap-admin` | public |
| `POST/PATCH/DELETE /api/conversations...`, `POST .../messages` | `get_current_user` |
| `POST /api/auth/invite` | `require_admin` |
| `POST /api/documents` (upload) and other admin document routes, when they exist | `require_admin` |

`GET /documents` is deliberately still public: it is the index of policy titles, not
their contents, and the frontend needs it before anyone has signed in.

Admin document routes do not exist in Phase 1 (the admin panel is mock data), so
`require_admin` has exactly one route to cover today. The dependency is written so
adding them is a one-line change, and the 403 path is tested with a real
non-admin account rather than a mocked user object.

---

## 7. Rate limiting

`slowapi` limiter, `5/minute` keyed by client IP, applied **only** to
`POST /api/auth/login`, `POST /api/auth/accept-invite`, and
`POST /api/auth/bootstrap-admin`. Exceeding it returns `429` with a
`Retry-After` header. The limiter is in-memory: a single-process backend gets
correct per-IP behaviour, and it is documented as per-instance rather than
pretending to be a shared store.

---

## 8. Input validation and sanitisation

- `EmailStr` plus a `field_validator` requiring the company domain — shared by
  invite creation and login, so the rule cannot drift between them.
- Explicit `min_length`/`max_length` on every string field; password length is
  bounded at both ends so bcrypt's 72-byte limit cannot be hit with a long input.
- `sanitize_text()` strips C0/C1 control characters (including newlines), trims,
  and collapses internal runs of whitespace. Applied to `name` and to any
  free-text the auth layer stores. Defence in depth: the data is structured, but
  a name is rendered into HTML elsewhere, so it is normalised once at the edge.
- Passwords are never logged, never returned, and never stored in plaintext. The
  login path logs the email and the outcome, never the submitted password.
- `password_hash` is never included in a response model.

---

## 9. Implementation order

1. `app/config.py` — auth settings, `company_email_domain`, `is_production`.
2. `app/database.py` — `User`, `Invite`, `RefreshSession` models.
3. `app/security.py` — hashing, JWT issue/verify, token generation, sanitisation.
4. `app/schemas_auth.py` — request/response models with the validators.
5. `app/dependencies.py` — `get_current_user`, `require_admin`.
6. `app/auth.py` — the router, all eight endpoints, rate limits, cookie helpers.
7. `app/bootstrap_admin.py` — CLI for the first admin.
8. `app/main.py` — register the limiter, include the router, move
   `get_db` into `dependencies.py` (shared), guard conversation routes, seed a
   dev admin when `AUTH_SEED_ADMIN_PASSWORD` is set.
9. `backend/tests/test_auth.py` — the full flow, plus the security checklist as
   executable assertions.
10. `requirements.txt`, `.env.example`, `backend/.env` — the new settings.
11. Frontend — below.

---

## 10. Frontend integration

| Piece | Where | What it does |
|---|---|---|
| `core/models/auth.model.ts` | new | `User`, `Role` (`'employee' \| 'admin'`), wire DTOs, `ROLE_LABELS`. |
| `core/services/auth.service.ts` | new | Signal-based state: `user`, `status`, `isAuthenticated`, `isAdmin`. `bootstrap()` runs on app init; `login`, `acceptInvite`, `refresh`, `logout`, `csrf`. |
| `core/services/api.service.ts` | extended | `withCredentials: true` on every call; auth methods added. |
| `core/guards/auth.guard.ts` | new | Waits for `bootstrap()`, redirects to `/login`. |
| `core/guards/admin.guard.ts` | new | `authGuard` then `role === 'admin'`, else redirect to `/`. |
| `core/interceptors/auth.interceptor.ts` | new | Attaches `X-CSRF-Token`; on 401 calls refresh once and replays; otherwise clears the user and routes to `/login`. |
| `login-view` | wired | Reactive form, `Validators.email`, calls `login`. |
| `accept-invite-view` | wired | Reads `?token=`, pre-fills from `GET /api/auth/invite/{token}`, submits to `accept-invite`. |
| `register` route | removed | Redirects to `/accept-invite`. No API behind it exists. |
| `app.routes.ts` | updated | Guards on `''`, `response*`, `conversations`, `admin*`; `data: { plain: true }` on signed-out routes. |
| `chat-sidebar` | wired | Sign-out calls the API; the admin link follows `auth.isAdmin()` instead of the preview toggle. |
| `viewer.service.ts`, `viewer.model.ts`, `role-preview-toggle` | deleted | Replaced by `AuthService`; the mock viewer and the role preview switch go with them, since a role the server does not grant is not a role. The tests that flipped it use `core/testing/auth-service.stub.ts`, which supplies the role the way `GET /api/auth/me` does. |
| `conversation.service.ts` | changed | Waits for the session before fetching the list, and refetches when a sign-in changes it. See §10a. |
| `auth-layout` | changed | The note that said nothing typed on a signed-out screen is sent anywhere is gone: it was true while the screens threw their input away, and a password typed into a form claiming to send nothing is worse than no note. |

Role naming: the backend speaks `employee` / `admin`. The Phase 1 UI used
`employee` / `administrator`. The wire values are kept as the server defines them
and the label stays "HR Administrator" in `ROLE_LABELS`.

Silent refresh is reactive rather than scheduled: the frontend never sees the access
token (it is `httpOnly`), so there is no expiry to count down to. A 401 on any
request triggers a single `POST /api/auth/refresh`; concurrent 401s share one
in-flight refresh and replay together, and the replay rebuilds its CSRF header from
the cookie the refresh rotated. If the refresh fails, the user is cleared and routed
to `/login`. There is also a `GET /api/auth/me` in an app initializer, which is what
makes a reload land straight back in the session.

Three consequences of that design that are easy to get wrong:

- **The guards and the interceptor both reach for `AuthService` before awaiting
  anything.** `inject()` only works synchronously inside an injection context, and a
  guard that resolves a dependency after an `await` gets `NG0203`.
- **Nothing is checked on the server.** A render has no cookies, so both guards defer
  there. That is safe because a render produces the shell and no data; the moment the
  client takes over, both guards run again with a real answer.
- **The streamed answer bypasses `HttpClient`.** It uses raw `fetch`, because
  `HttpClient` reads a response to completion and a stream has to be read as it
  arrives. That call therefore sets `credentials: 'include'` and the CSRF header
  itself, and asks for its own one-time refresh on a 401 — otherwise the one request
  that streams an answer would be the one request the interceptor never sees.

---

## 10a. What implementing this turned up

Five things the plan above did not know, each found by a test failing against a real
browser rather than by reasoning:

**1. `adminGuard` on the server redirected every admin deep link to the dashboard.**
The guard checked the session, deferred to the browser because a render has no
cookies, and then evaluated `role === 'admin'` against a user that does not exist on
the server — which reads as "not an administrator" for everybody. Opening `/admin` in
a fresh tab landed on `/`. The role check is now deferred on the same terms as the
session check, and `auth.guard.spec.ts` covers the server branch explicitly.

**2. `SameSite` is decided by host, not port.** `localhost:4201` calling
`localhost:8099` is one site and works. `127.0.0.1:4201` calling `localhost:8099` is
two, and the browser silently withholds the session cookies — sign-in appears to
succeed, the cookies are stored, and every later request is a 401. This is the most
likely way this deployment breaks, and it is written up at the top of
`core/api.config.ts`. In production it is the same question: the Render frontend and
the Render API must not be bare subdomains of one domain.

**3. An `HttpClient` request is cold.** The CSRF token was being *built* after sign-in
and never subscribed to, so it was never fetched. The symptom was subtle: nothing
broke on the sign-in screen, and the first state-changing request after a reload
failed with a 403 until something else happened to ask for the token.

**4. Refreshing rotated into a new family.** `set_session_cookies` minted a fresh
`family_id` on every call, including on rotation. Reuse detection then revoked only
the token that was already dead and left the live one working — the one case the whole
mechanism exists for. Rotation now continues the family, and there is a test that
asserts it directly.

**5. The conversation list asked before it knew whether anybody was signed in.** It
was constructed and fetched unconditionally, which after the routes went behind a
session produced a 401, a console error and an empty sidebar on every signed-out page
load. `ConversationService` now waits for the status and re-loads when a sign-in
changes it.

---

## 10b. How somebody actually gets an account

There is no self-registration, and that is a security decision rather than a missing
feature: an open form would let anyone who can type a colleague's address claim that
address, because the domain check only proves they typed it. Two ways in instead, and
both keep an administrator in the loop.

| Who | How |
|---|---|
| An employee | `/register` — a name and a work email. Creates a *request*, not an account. |
| Somebody chosen by an administrator | **Admin → Invite** — generates an invitation link. |

The request model has no `role` field at all, which is the security property rather
than an omission: an administrator role can only be granted by an administrator
sending `role: "admin"` to the approve route. Approving provisions the account and
returns the same invitation link the Invite screen produces, so there is one way to
mint a link and one code path that does it.

**With no mail service, the link is the deliverable.** Both admin screens show it with
a Copy button and an "Open it" link, and both state that it works once and expires
after 72 hours. The administrator sends it by whatever means the company already uses.
That is worse than sending an email and it is deliberately not hidden — there is no
queue and nothing silently dropped, so "the invitation was sent, we think" cannot
happen.

The first administrator comes from `python -m app.bootstrap_admin`, or from
`AUTH_SEED_ADMIN_*` in `.env` for local work, which is refused in production and runs
the password through the same policy as any other.

---

## 11. Security checklist, as tests

Each line below is an executable assertion, not a claim. The `backend tests` column
is `backend/tests/test_auth.py`, the `live API` column is
`backend/scripts/verify_auth_checklist.sh`, and the `browser` column is
`frontend/scripts/verify_auth_e2e.mjs`.

| # | Checklist line | backend tests | live API | browser |
|---|---|---|---|---|
| 1 | Tokens never appear in a response body | ✓ | ✓ | ✓ |
| 1b | Nor in `localStorage`, `sessionStorage`, or a JS-readable cookie | — | — | ✓ |
| 2 | Cookies are `HttpOnly`, `Secure`, `SameSite`, `Path=/` | ✓ | ✓ | ✓ |
| 3 | Refresh tokens rotate, and reuse of an old one is detected | ✓ | ✓ | ✓ |
| 4 | Passwords are bcrypt hashes, never logged or returned | ✓ | ✓ | ✓ |
| 5 | `login` and `accept-invite` are rate limited | ✓ | ✓ | — |
| 6 | CSRF is mitigated for cookie-based state-changing requests | ✓ | ✓ | ✓ |
| 7 | The company domain is validated server-side, not just in the browser | ✓ | ✓ | ✓ |
| 8 | Admin-only routes reject non-admins with 403 | ✓ | ✓ | ✓ |
| 9 | No open self-registration endpoint exists anywhere | ✓ | ✓ | ✓ |
| 10 | A request for access creates no account | ✓ | — | ✓ |
| 11 | A requester cannot name their own role | ✓ | — | ✓ |
| 12 | An employee can neither read nor decide the queue | ✓ | — | ✓ |

Notes on the three that are less obvious than they look:

**Line 1, in a browser.** The in-process suite can assert that a response body holds
no token, but only a real browser can show that `document.cookie`, `localStorage` and
`sessionStorage` hold none either. That check is in the e2e script and reads the
browser's own storage and jar, not the app's view of them. It also asserts the
opposite for `ika_csrf`, which is meant to be readable — a blanket "nothing is
readable" test would have passed while the double-submit mechanism was broken.

**Line 2, `Secure`.** `Secure` is asserted separately from the other flags because it
cannot be asserted alongside them: a `Secure` cookie is not sent over the plain http a
local run uses, so a test that demanded it would have no session to test. What is
asserted is that `Secure` is on in production regardless of the setting, which is the
property that actually matters.

**Line 8, with a real account.** The employee in these tests was invited, accepted and
signed in through the ordinary flow, and its 403 comes from a genuinely signed token
over a genuine session. A test that stubbed the user object would pass whatever the
dependency did, which is the thing most worth checking.

## 12. Running it

```bash
# Backend, from backend/
.venv/bin/python -m unittest tests.test_auth tests.test_conversations tests.test_engine_stream
uvicorn app.main:app --port 8099 --host 127.0.0.1 --reload

# The shell checklist needs that server running, and once a minute rather than twice:
# it signs in several times and the sign-in routes are limited to five a minute, so a
# second run in the same minute fails on 429s that say nothing about the code. It
# takes the rate-limit check last for the same reason.
#
# If the backend was started with AUTH_SEED_ADMIN_* the first administrator already
# exists, so pass its details rather than expecting the script to bootstrap one:
ADMIN_EMAIL=admin@acmetech.example ADMIN_PASSWORD=... \
SQLITE_DB=checklist.db ./scripts/verify_auth_checklist.sh

# The first administrator, from backend/
python -m app.bootstrap_admin --email you@acmetech.example --name "Your Name"

# Frontend, from frontend/
npm test
npm start                                    # then, in another terminal:
AUTH_BOOTSTRAP_KEY=... \
  APP_URL=http://127.0.0.1:4200 API_URL=http://127.0.0.1:8099 \
  node scripts/verify_auth_e2e.mjs
```

`verify_auth_e2e.mjs` needs an empty backend database, because creating the first
administrator works exactly once by design and the script provisions its own. It says
so and stops rather than failing obscurely further on.

The frontend must be pointed at the local backend for these runs: set
`API_BASE_URL` in `core/api.config.ts` to `http://127.0.0.1:8099`. Both sides must
use `127.0.0.1` — see §10a.