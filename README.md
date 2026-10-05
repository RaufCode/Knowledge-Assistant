# Knowledge Assistant Backend

Internal knowledge assistant API for **Acme Technologies**. Answers employee questions using RAG (Retrieval-Augmented Generation) over company policy documents, powered by NVIDIA NIM.

> **Not an AmaliTech product.** The repository lives under an `Amalitech/` directory and
> AmaliTech's brand assets were used as a placeholder palette, but the product is for
> Acme Technologies and its users are Acme employees — accounts only exist for
> `@acmetech.example` addresses, and that rule is enforced server-side. Nothing in
> either should be read as an AmaliTech deployment. The Tailwind theme tokens still
> hold placeholder colours and need replacing with Acme's verified brand values.

## Tech Stack

- **Framework:** FastAPI
- **LLM:** gpt-oss on NVIDIA NIM (`openai/gpt-oss-20b`, via the OpenAI-compatible API)
- **Embeddings:** NVIDIA `nvidia/nemotron-3-embed-1b`, a retrieval/QA model rather than a general-purpose embedder
- **RAG Pipeline:** LlamaIndex
- **Database:** PostgreSQL (SQLAlchemy ORM)
- **Authentication:** invite-only, cookie sessions — HS256 JWTs via `python-jose`, bcrypt via `passlib`, rate limiting via `slowapi`. See `Phase_2_Authentication.md`.
- **Deployment:** Docker + Render

## Project Structure

```
backend/
├── app/
│   ├── __init__.py
│   ├── main.py            # FastAPI app & routes
│   ├── config.py          # Settings (env-based)
│   ├── database.py        # SQLAlchemy models & session
│   ├── schemas.py         # Pydantic models for conversations
│   ├── auth.py            # The /api/auth routes
│   ├── security.py        # Token signing, password hashing, sanitisation
│   ├── dependencies.py    # get_current_user, require_admin, CSRF check
│   ├── schemas_auth.py    # Pydantic models for auth, incl. the domain rule
│   ├── rate_limit.py      # Per-IP limits on sign-in routes
│   ├── bootstrap_admin.py # Creates the first administrator, from a shell
│   └── rag/
│       ├── __init__.py
│       ├── engine.py      # RAG assistant (retrieve + generate)
│       ├── guard.py       # Personal-question filter
│       └── ingest.py      # Document loading & indexing
├── data/                  # Policy markdown documents (13 files)
│   ├── 00-README.md
│   ├── 01-company-overview.md
│   └── ...
├── scripts/
│   ├── tune.py                     # Retrieval threshold tuning
│   └── verify_auth_checklist.sh    # Walks the auth security checklist against a running server
├── tests/
│   ├── test_auth.py        # Auth, at the level of the HTTP contract
│   ├── test_conversations.py
│   └── test_engine_stream.py
├── Dockerfile
├── requirements.txt
├── .env.example
└── README.md
```

## Local Setup

### Prerequisites

- Python 3.12+
- PostgreSQL 14+ (or use Docker below)
- Two NVIDIA API keys from [build.nvidia.com](https://build.nvidia.com): one for
  generation, one for retrieval

### Option 1: Run with Docker (Recommended)

```bash
# Build and run
docker build -t knowledge-assistant .
docker run -p 8000:8000 \
  -e NVIDIA_API_KEY=your_generation_key \
  -e NVIDIA_EMBEDDING_API_KEY=your_retrieval_key \
  -e DATABASE_URL=postgresql://user:password@host:5432/knowledge_assistant \
  knowledge-assistant
```

### Option 2: Run Locally

```bash
# 1. Create virtual environment
python -m venv .venv
source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Set up environment variables
cp .env.example .env
# Edit .env with your NVIDIA keys (generation + retrieval) and database URL

# 4. Create the first administrator
#
# Accounts are invite-only, so somebody has to be made first. This refuses to run
# once any administrator exists, and asks for the password without echoing it.
python -m app.bootstrap_admin --email you@acmetech.example --name "Your Name"

# 5. Run the app
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Everyone else joins by invitation: sign in as an administrator and use
`POST /api/auth/invite`. It returns the invitation link, because no mail service is
configured — an administrator copies it and sends it themselves.

### Opening the app from a phone

The backend runs on `127.0.0.1:8099` and the app on `4200`. To use the app on a
phone, serve the app on your wifi and open it by your machine's LAN address:

```bash
npm run start:dev -- --host 0.0.0.0 --port 4200
```

Then on the phone, `http://<your-machine-ip>:4200`. The dev-server proxy forwards
`/api` to the backend, so the phone only ever talks to one origin and needs no
extra configuration. Add that address to `ALLOWED_ORIGINS` and
`CSRF_TRUSTED_ORIGINS` in `backend/.env`, spelled exactly as the browser sends it:

```bash
ALLOWED_ORIGINS=http://localhost:4200,http://192.168.1.20:4200
CSRF_TRUSTED_ORIGINS=http://localhost:4200,http://192.168.1.20:4200
```

A refusal names the origin it did not recognise, so a mistyped address is a 403
that tells you what to fix rather than one that looks like a broken interceptor.

### Why the app serves the API itself

The app serves `/api` from its own origin — through the dev-server proxy in
development, and through a reverse proxy in `src/server.ts` in production. That is
deliberate, and it is the reason sign-in works on a phone as well as on a laptop.

The session is two `httpOnly` cookies. Whether a browser attaches them to an API
call is decided from the *site* that call goes to, and it is not something the app
can influence. Call the API from its own origin and the cookies are first-party by
construction, so no third-party cookie policy and no `SameSite` attribute can
withhold them. Call it from another origin and each browser applies its own rules —
Safari and Chrome block or partition third-party cookies, and `SameSite=Lax`
withholds the cookies from any cross-site `fetch`.

The failure is indistinguishable from a wrong password: the sign-in request answers
`200`, the cookies are stored, and the very next call answers `401`. It appears and
disappears with the browser and the device rather than with the code, which is why
it reported as "you signed in, but this browser did not keep the session" on a
phone while the same build worked on a laptop. Serving the API through the app
removes the decision from the browser entirely.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NVIDIA_API_KEY` | Yes | — | NVIDIA key used for generation |
| `NVIDIA_EMBEDDING_API_KEY` | Yes | — | Separate NVIDIA key used for retrieval |
| `NVIDIA_BASE_URL` | No | `https://integrate.api.nvidia.com/v1` | OpenAI-compatible NVIDIA endpoint |
| `LLM_MODEL` | No | `openai/gpt-oss-20b` | Model used for generation |
| `LLM_MAX_TOKENS` | No | `1024` | Output token ceiling |
| `LLM_TEMPERATURE` | No | `0.5` | Sampling temperature |
| `LLM_TOP_P` | No | `1` | Nucleus sampling cutoff |
| `LLM_MAX_ATTEMPTS` | No | `3` | Attempts before a 429/5xx is given up on |
| `EMBED_MODEL` | No | `nvidia/nemotron-3-embed-1b` | Model used for retrieval embeddings |
| `DATABASE_URL` | No | `postgresql://user:password@localhost:5432/knowledge_assistant` | PostgreSQL connection string |
| `ALLOWED_ORIGINS` | No | `*` | Comma-separated CORS origins. Needed in production because the CSRF origin check compares against it. The browser itself reaches the API through the app's own `/api` proxy, so this no longer governs whether cookies are sent |
| `ENVIRONMENT` | No | `development` | `production` forces `Secure` cookies and refuses the seeded admin |
| `AUTH_SECRET_KEY` | Yes | — | Signs both token types. At least 32 characters |
| `COMPANY_EMAIL_DOMAIN` | No | `acmetech.example` | The only domain an account may be created against |
| `ACCESS_TOKEN_TTL_SECONDS` | No | `900` | Access token lifetime (15 minutes) |
| `REFRESH_TOKEN_TTL_SECONDS` | No | `1209600` | Refresh token lifetime (14 days) |
| `INVITE_TTL_SECONDS` | No | `259200` | How long an invitation can be opened (72 hours) |
| `BCRYPT_ROUNDS` | No | `12` | Password hashing cost |
| `AUTH_COOKIE_SECURE` | No | `true` | `false` only for local http. Production forces it on regardless |
| `AUTH_COOKIE_SAMESITE` | No | `lax` | `SameSite` on the session cookies. `lax` is correct here because the app serves its own `/api` reverse proxy, so every request is same-site. `none` is only for an API the browser must call on another origin, and it makes the cookies third-party — which is what browsers increasingly refuse to send |
| `CSRF_TRUSTED_ORIGINS` | No | falls back to `ALLOWED_ORIGINS` | Origins allowed to make cookie-authenticated writes. Must match the app's origin exactly — `localhost` and `127.0.0.1` are different, and a mismatch shows up as a 403 that names the origin it refused |
| `FRONTEND_BASE_URL` | No | `http://localhost:4200` | Where an invitation link points |
| `AUTH_BOOTSTRAP_KEY` | No | — | Guards the one route that can create the first administrator. Prefer `python -m app.bootstrap_admin` |
| `AUTH_SEED_ADMIN_EMAIL` / `_PASSWORD` / `_NAME` | No | — | Seeds an administrator at startup. Ignored when `ENVIRONMENT=production` |
| `TOP_K` | No | `4` | Number of documents to retrieve |
| `MIN_SCORE` | No | `0.40` | Minimum similarity score threshold |
| `DATA_DIR` | No | `data` | Path to policy documents |

`AUTH_SECRET_KEY` can be generated with:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Rotating it signs every existing session out, which is the intended effect.

## Authentication

Two roles: `employee` and `admin`. There is no self-registration endpoint — an open
form would let anyone who can type a colleague's address claim that address, since a
domain check only proves they typed it. There are two ways in instead:

| Who | How |
|---|---|
| An employee | Opens `/register`, fills in a name and work email, and waits. An administrator reviews it and approves. |
| Somebody an administrator chose | The administrator generates an invitation link from **Admin → Invite** and sends it themselves. |

An access request creates **no account**. A `users` row appears only when an
administrator approves, and the role is set by that approval — a requester cannot
name one, because the field is not on the model. Approving mints the same
single-use invitation link the Invite screen does.

### There is no mail service, so how does an invitation arrive?

By hand, and the product says so rather than pretending. Approving or generating an
invitation returns a link that the **Admin → Invite** and **Admin → Access requests**
screens display with a **Copy link** button and an "Open it" link for checking before
sending. The administrator then sends it however the company already communicates.

That is a worse experience than sending an email, and it is deliberately not a hidden
one. There is no queue and nothing silently dropped: either the link leaves the
administrator's hands or it does not, and an unclaimed invitation expires after 72
hours and can be issued again. What it avoids is "the invitation was sent, we think".

### The first administrator

Accounts are invite-only, so somebody has to exist before anybody can be invited.
Two ways:

```bash
# From a shell. The password is read without an echo.
python -m app.bootstrap_admin --email you@acmetech.example --name "Your Name"

# Or set these in backend/.env and let startup seed one. Refused when
# ENVIRONMENT=production, and the password goes through the same policy as any other.
AUTH_SEED_ADMIN_EMAIL=you@acmetech.example
AUTH_SEED_ADMIN_PASSWORD=<something long>
```

**Remove the seeded password once a real administrator exists.** A known password in
a `.env` file is a standing way in, and `.env` is gitignored but not secret.

The session is a pair of `httpOnly` cookies — a 15-minute access token and a 14-day
refresh token, both HS256. Neither ever appears in a response body, in storage, or
in a cookie JavaScript can read; the only readable cookie is the double-submit CSRF
token, which carries no authority of its own.

Refresh tokens rotate on every use, and presenting one that has already been
exchanged is treated as possible theft: the whole family is revoked and both parties
have to sign in again. A client that simply never dropped an old cookie looks
identical from the server, so the safe answer is to end the family rather than guess.

`login` and `accept-invite` are rate limited to 5 attempts a minute per IP, and
state-changing requests need an `X-CSRF-Token` header matching the `ika_csrf` cookie.

The design, the schema, and the security checklist are in
[`Phase_2_Authentication.md`](Phase_2_Authentication.md). The checklist is executable:
73 in-process tests, a shell script that walks it against a running server, and a
real-browser script that walks the whole flow end to end — including asking for
access, an administrator answering, and generating an invitation.

```bash
.venv/bin/python -m unittest tests.test_auth tests.test_conversations tests.test_engine_stream

# Once a minute, and with the server running. It signs in several times and sign-in is
# limited to five attempts a minute, so two runs back to back fail for a reason that
# has nothing to do with the code.
ADMIN_EMAIL=... ADMIN_PASSWORD=... SQLITE_DB=checklist.db \
  ./scripts/verify_auth_checklist.sh
```

`MIN_SCORE` is tied to `EMBED_MODEL`: different embedding models produce different
score ranges, so after changing it check the numbers with

```bash
PYTHONPATH=. python scripts/tune.py
```

A threshold that is too high makes every question look like "not found" with no
error anywhere, which is the most likely thing to break when swapping providers.

`EMBED_MODEL` also has to exist in NVIDIA's catalog. Several plausible choices
(`nvidia/llama-3.2-nv-embedqa-1b-v2`, `nvidia/nv-embedqa-e5-v5`,
`nvidia/nv-embed-v1`, `baai/bge-m3`) now answer `410 Gone`, and a retired model
fails the same silent way as a mistuned threshold: startup errors out.

Failures are reported rather than swallowed: a 429 or 5xx is retried with
exponential backoff, and once the attempts are used up `/chat` answers 503 and
writes no history row. `/health` reports `degraded` when the generation key is
missing and `embedding_configured` for the retrieval key.

## API Endpoints

### Authentication

All of these live under `/api/auth`. Tokens are returned as `httpOnly` cookies, never
in a response body.

| Method | Path | Guard | Purpose |
|---|---|---|---|
| `GET` | `/api/auth/csrf` | public | Issues a CSRF token and sets the readable cookie |
| `POST` | `/api/auth/login` | public, rate limited | Signs in; sets both cookies |
| `POST` | `/api/auth/accept-invite` | public, rate limited | `{ token, password }` — activates the account and signs in |
| `POST` | `/api/auth/refresh` | refresh cookie | Rotates the refresh token, issues a new access token |
| `POST` | `/api/auth/logout` | refresh cookie | Revokes the session and clears both cookies |
| `GET` | `/api/auth/me` | access cookie | The signed-in user: `id`, `name`, `email`, `role` |
| `POST` | `/api/auth/invite` | **admin** | Creates a pending user, returns the invite link |
| `POST` | `/api/auth/accounts` | **admin** | Creates an active user outright, with a password the admin chooses |
| `POST` | `/api/auth/request-access` | public, CSRF, rate limited | `{ name, email, password }` — registers. Creates no account until approved |
| `GET` | `/api/auth/requests` | **admin** | Everybody waiting, pending first |
| `POST` | `/api/auth/requests/{id}/approve` | **admin** | Activates the account with the chosen password (invite link only for pre-password requests) |
| `POST` | `/api/auth/requests/{id}/decline` | **admin** | Turns it down; provisions nothing |
| `GET` | `/api/auth/invite/{token}` | public | What the invitation is for, to pre-fill the accept screen |
| `POST` | `/api/auth/bootstrap-admin` | `AUTH_BOOTSTRAP_KEY`, once only | Creates the first administrator |

A signing-in example, which is the shortest way to see the cookie flags:

```bash
curl -i -c jar.txt -X POST http://localhost:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@acmetech.example","password":"..."}'
```

Every state-changing request other than the four exempt ones needs
`X-CSRF-Token` matching the `ika_csrf` cookie.

### Health Check

```bash
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "index_ready": true,
  "llm_configured": true,
  "embedding_configured": true,
  "llm_model": "openai/gpt-oss-20b"
}
```

---

### List Documents

```bash
GET /documents
```

**Response:**
```json
[
  "Company Overview",
  "Technical Departments and Tech Stack",
  "Working Hours Policy",
  "Leave Policy",
  ...
]
```

---

### Ask a Question

```bash
POST /chat
Content-Type: application/json

{
  "session_id": "user-session-123",
  "question": "What is the annual leave policy?"
}
```

**Response (success):**
```json
{
  "answer": "Employees are entitled to 21 days of annual leave...",
  "answered": true,
  "sources": [
    {
      "document": "Leave Policy",
      "section": "Annual Leave",
      "snippet": "All full-time employees are entitled to 21 days...",
      "score": 0.823
    }
  ]
}
```

**Response (not found):**
```json
{
  "answer": "I couldn't find that in the company documents. Please contact HR at hr@acmetech.example or +233 30 000 0000.",
  "answered": false,
  "sources": []
}
```

**Response (personal question blocked):**
```json
{
  "answer": "I can only answer general policy questions and I can't access personal records such as leave balances, salaries or payslips...",
  "answered": false,
  "sources": []
}
```

`session_id` is the conversation the turn is filed under. An existing, unexpired
session is appended to; no session is ever created here. A session that has expired
or never existed is answered with **410 Gone** and `{"error": "session_expired"}`
rather than with `answered: false` — see [Expired or Unknown Session](#expired-or-unknown-session).

---

### Ask a Question (streaming)

```bash
POST /chat/stream
Content-Type: application/json

{
  "session_id": "user-session-123",
  "question": "What is the annual leave policy?"
}
```

Same request and same history side effects as `/chat`, but the answer arrives as it
is written instead of all at once. The response is `text/event-stream`, with one
JSON object per `data:` line:

| Event | Meaning |
| --- | --- |
| `status` | The answer is being written, before any of it exists yet. |
| `delta` | A piece of the answer text. Repeat until `done`. |
| `done` | The complete answer and its citations. Sent exactly once, and it is the authoritative one. |
| `error` | The answer could not be finished. Any partial text stays visible. |

```
data: {"type":"status","stage":"writing"}

data: {"type":"delta","text":"Full-time employees "}

data: {"type":"delta","text":"accrue 25 days of annual leave a year."}

data: {"type":"done","answer":"Full-time employees accrue 25 days of annual leave a year.","answered":true,"sources":[...]}
```

`done` carries the same `answer`, `answered` and `sources` as `/chat`, so a client
can render the streamed text as it arrives and then replace it with the finished
answer. That matters for the two cases where the final answer differs from what
was being written: a question the documents do not answer, and one refused as a
personal-data question, both stream their canned wording before `done` corrects
the turn to its real outcome.

The citations ride only on `done`, never on an event of their own part way
through. `done` can still replace the answer with a refusal that cites nothing,
so a client that drew sources before the text would be showing evidence for an
answer that had not been given. Render the citation block when `done` arrives.

The turn is only written to history when the stream completes, so a request
abandoned half way leaves no half-answer behind.

```bash
curl -N -X POST http://localhost:8000/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"user-session-123","question":"What is the annual leave policy?"}'
```

---

### Expired or Unknown Session

Both `/chat` and `/chat/stream` answer a message posted under a session that has
expired, or an id that never existed, with **410 Gone** before any answer work
starts:

```json
{
  "error": "session_expired",
  "message": "Your session has expired. Start a new session to ask again."
}
```

This is deliberately not a 200 with `answered: false`. That is the same body a
genuinely unanswered question returns, so the client filed "your question has no
answer" on a question that was never asked, and went on posting follow-ups into a
session the backend had already deleted. The `session_expired` code is what lets a
client offer the one action that helps: create a new session and resend.

---

### Sessions

A conversation is one session, created once:

```bash
POST /sessions
```

```json
{ "session_id": "3f9c...", "expires_at": "2026-09-30T09:30:00" }
```

Every later message in that conversation sends the **same** `session_id` back in
its body, and the backend appends the turn to that session's history rather than
opening a new one. Nothing else creates a session, so `/history/{session_id}`
returns the whole conversation instead of only its most recent turn, and a follow-up
question cannot land in a session of its own.

Sessions last 30 minutes from creation and are not extended by activity. When one
lapses, the next message is answered with the 410 above and the client is expected
to open a replacement.

---

### Get Chat History

```bash
GET /history/{session_id}
```

**Example:**
```bash
GET /history/user-session-123
```

**Response:**
```json
[
  {
    "question": "What is the annual leave policy?",
    "answer": "Employees are entitled to 21 days of annual leave...",
    "answered": true,
    "sources": [...],
    "created_at": "2026-09-29T15:30:00Z"
  }
]
```

## Testing with cURL

```bash
# Health check
curl http://localhost:8000/health

# List documents
curl http://localhost:8000/documents

# Ask a question
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"session_id": "test-session-123", "question": "What are the working hours?"}'

# Get history
curl http://localhost:8000/history/test-session-123
```

## Deployment (Render)

The `render.yaml` at the repo root configures both services automatically: the
FastAPI backend and the Angular app, server-rendered by its own Express server.

1. Connect the `knowledge-assistant` repo to Render
2. Set `NVIDIA_API_KEY`, `NVIDIA_EMBEDING_API_KEY`, `AUTH_SECRET_KEY`,
   `AUTH_BOOTSTRAP_KEY` and `DATABASE_URL` in the Render dashboard — everything
   else in the blueprint is already set
3. Create the first administrator with `python -m app.bootstrap_admin`, then remove
   `AUTH_BOOTSTRAP_KEY`

The blueprint sets `API_ORIGIN` on the app so its `/api` proxy knows where the
backend is, which is what keeps the session cookies first-party in production. If
you deploy the two services yourself, set it on whatever serves the app. Leaving it
unset points the proxy at `http://127.0.0.1:8099`, which is correct locally and
nowhere else.

`ALLOWED_ORIGINS`, `CSRF_TRUSTED_ORIGINS` and `FRONTEND_BASE_URL` all have to name
the app's real origin. Note that `render.yaml` leaves the app's own name to Render
to generate, so read the URL off the service page after the first deploy rather
than assuming it — and keep the three settings in step with it.

## API Docs

Once running, interactive Swagger docs are available at:
- `http://localhost:8000/docs` (Swagger UI)
- `http://localhost:8000/redoc` (ReDoc)
