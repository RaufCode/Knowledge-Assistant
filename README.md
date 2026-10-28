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
│       ├── engine.py      # RAG assistant (classify + retrieve + generate)
│       ├── guard.py       # Classification and the confidentiality guard (conversational / question / follow-up / expansion / out of scope / restricted)
│       ├── capabilities.py # The assistant FAQ: every question about itself, with its approved answer
│       ├── ingest.py      # Document loading & indexing
│       └── retrieval.py   # Hybrid retrieval: vector + keyword, merged with RRF
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
│   ├── test_engine_stream.py
│   ├── test_conversational.py # Everything that is not a request, answered without retrieval
│   ├── test_confidentiality.py # What the guard refuses, and what it must not
│   ├── test_expansion.py       # Continuing an answer from the passages it used
│   ├── test_hybrid_retrieval.py  # Both searches, their fusion, and the golden set
│   ├── test_transcript_fixes.py  # One conversation, replayed turn by turn
│   ├── test_stored_citations.py   # Citations as stored and read back
│   └── test_intent.py      # Which path a message takes before retrieval
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

The backend runs on `127.0.0.1:8000` and the app on `4200`. To use the app on a
phone, serve the app on your wifi and open it by your machine's LAN address:

```bash
npm run start:dev -- --host 0.0.0.0 --port 4200
```

Then on the phone, `http://<your-machine-ip>:4200`. The dev-server proxy forwards
`/api` to the backend, so the phone only ever talks to one origin and needs no
extra configuration — not even an entry in an allow-list, because the request
arrives at the backend naming the host the app itself was served at.

A refusal names the origin it did not recognise, so a mistyped address is a 403
that tells you what to fix rather than one that looks like a broken interceptor.

### Where the API is, and why the phone was different

`frontend/public/config.json` is `""`, which means the app serves `/api` from its
own origin: the dev-server proxy in `proxy.conf.json` in development, the Express
reverse proxy in `src/server.ts` when the app is server-rendered on Render, and the
external rewrite in `frontend/vercel.json` when it is static on Vercel. The
backend's address is `API_ORIGIN` on Render and the rewrite `destination` on
Vercel, and the browser is never told it — every request it makes is to the
address the page came from.

That is what makes the session stick. The session is `httpOnly` cookies, and a
cookie is attached based on the *site* a request goes to. With the browser calling
the backend on its own origin, those cookies are first-party, and no browser policy
is left to get wrong: Safari's ITP and Chrome's third-party-cookie phase-out both
apply to third-party cookies, and both apply to them differently per browser and per
device. `AUTH_COOKIE_SAMESITE` therefore defaults to `lax`, which works because the
request is same-site by construction rather than by luck.

The earlier version of this had the browser call
`https://knowledge-assistant-chatbot.onrender.com` directly, which made the cookies
third-party, and it worked on some desktops and failed on phones with nothing in the
code to explain the difference. `AUTH_COOKIE_SAMESITE=none` is still available for an
API the browser genuinely has to reach on an origin of its own; it is refused when it
would be issued without `Secure`, because every browser drops that combination
silently and still answers `200`.

One trap is left, and it is the one nobody suspects: the backend marks its cookies
`Secure` in production, and a browser will not store a `Secure` cookie for a page
served over plain http — it drops it without a word, so sign-in still answers `200`
and the next call answers `401`. Running the app over http therefore needs a local
backend, which serves its cookies without `Secure`. The proxy does not change this:
it is the page's scheme that decides, not the hop behind it.

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
| `HR_EMAIL` | No | `hr@acmetech.example` | Who a reply names when it routes a reader to a human: a gap in the documents, or a question about the assistant |
| `HR_PHONE` | No | `+233 30 000 0000` | The same contact's number. Configured rather than written into the reply strings so a deployment corrects it in one place |
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
| `MIN_SCORE` | No | `0.40` | Minimum vector-similarity score. Tied to `EMBED_MODEL` |
| `RECALL_FLOOR` | No | `0.15` | When nothing clears `MIN_SCORE`, chunks above this are still passed to the generator to rule on. A recall setting, not a relevance one — see below |
| `RECALL_CANDIDATES` | No | `4` | How many such chunks are passed on |
| `VECTOR_CANDIDATES` | No | `10` | How far down the vector search looks. Also the window a keyword hit may rescue from |
| `KEYWORD_CANDIDATES` | No | `10` | The same, for the keyword search |
| `KEYWORD_MIN_SCORE` | No | `2.0` | Minimum BM25 score. A corpus-size scale, not a similarity one, so it is not comparable with `MIN_SCORE` |
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

## How a question is answered

Two decisions happen before anything is retrieved, and both of them exist because
the alternative was an answer that was wrong rather than one that was missing.

**What kind of message is this?** The classifier (`app/rag/guard.py`) sees the
message *and the last few turns of the conversation*, because a follow-up cannot
be recognised from its own words — "and if I'm part time?" is a complete,
in-scope, self-contained question that only means something because of what came
before it.

| Category | Example | What happens |
| --- | --- | --- |
| Conversational | "hey", "thanks", "ok", "there is no question", "who are you?" | A short reply that acknowledges what was said. No retrieval. |
| Company question | "How many sick days do I get?" | Retrieved and answered from the documents, with citations. |
| Follow-up | "what about contractors?" | Rewritten into a standalone question first — *what does the Code of Conduct say about contractors?* — then retrieved as above. |
| Expansion | "anything else?", "tell me more" | Continued from the documents the last answer cited, minus the chunks this thread already **used**. Never a gap in the corpus. |
| Out of scope | "how many presidents has Ghana had?" | A statement of what the assistant is for. No retrieval. |
| Restricted | "what is Ama's salary?", "what is my salary?" | The confidentiality notice. No retrieval. |

Four rules decide the awkward cases, and all four exist because the alternative
was a wrong answer rather than a missing one:

- **Judge by intent, not punctuation.** No question mark does not mean there is no
  question, and a question mark does not mean there is a company question.
- **Out of scope requires a request.** "how many presidents has Ghana had?" asks
  for something. "there is no question" asks for nothing, and forcing it into the
  nearest category is what answered a remark about the chat with a refusal, and a
  false gap in the corpus.
- **When it is unclear, it is conversational.** Being wrongly conversational costs
  the reader one more message. Being wrongly refused, or wrongly sent to the
  documents, makes the product look broken.
- **A follow-up is not an expansion.** A follow-up brings a new subject and is
  retrieved as one; an expansion brings none and is continued from where the last
  answer stopped. "what about contractors?" is the first, "anything else?" the
  second, and the difference is the subject rather than the politeness.

Greetings, acknowledgements and questions about the assistant itself are decided by
a rule check with no model call at all, so "ok" costs a reply rather than a reply
plus a classification. Everything else goes to the classifier, whose reply is
validated against a strict schema: an unreadable or unknown category falls back to
*company question*, so a classifier quirk can never turn an answer the documents
hold into a refusal.

### Questions about the assistant

"do you understand chinese?" used to be answered *"I'm happy to help with any
questions you have. Just let me know what you need."* Two things had to be true for
that, and both were wrong. The description of the assistant said nothing about
languages, so the question matched no rule and fell through to the conversational
path; and that path's instructions explicitly **forbid** it from stating facts about
the assistant, so improvising was all it could do. A direct question cannot be
answered with an invitation to ask one.

So every fact the assistant states about itself now lives in one editable file,
`app/rag/capabilities.py`, as a table of entries. Each has an id, the phrases that
reach it, and the **approved answer**:

| id | covers |
| --- | --- |
| `identity` | what it is and what it is for |
| `topics` | which subjects the documents cover |
| `sources` | how an answer is produced and how it is cited |
| `confidence` | what the confidence figure measures |
| `limits` | what it cannot do — no internet, documents only |
| `personal_records` | no access to payslips, leave balances or anyone's records |
| `contact` | who to contact, from `HR_EMAIL` / `HR_PHONE` |
| `languages` | which languages it can be used in |
| `memory` | whether earlier conversations are remembered — **unknown** |
| `privacy` | whether chats are private and how long they are kept — **unknown** |

Three rules, and the order matters:

1. **Rules first.** A recognised question is answered from its entry directly, with
   no model call.
2. **Then the model picks an entry id** from the closed list. It never writes an
   answer, so it cannot invent one — the reply that follows is read out of the table
   by id.
3. **An id that does not exist, or a model that cannot be reached,** is answered
   honestly: *"I'm not sure about that one. I can help with questions about company
   policies, onboarding, leave and IT setup."*

**The two unknown entries are the point of the table.** Nobody has established what
this deployment does with a conversation once it is closed, or who can see one, and
an invented assurance about a reader's data is the worst answer available to either
question. Each carries a `TODO` marker for whoever edits the file and says *"I don't
know"* in the answer itself, because "is TODO" is not an answer to anybody.

**The languages entry was measured, not guessed.** The configured model was asked
the same questions in Chinese and French. It follows both correctly — it identified
the subject of 公司的请假政策是什么？ and answered a French question accurately given
the context — but the **documents are English only**, so a question in another
language retrieves nothing, and the model's own answer to that was to report that
the documents did not cover the topic: a confident false `not_found` produced
entirely by the language of the question. The entry therefore claims comprehension
and states where it bites, and claims no fluency, because none was measured.

**Scripts.** A message mostly in Han, Arabic or Cyrillic is answered **in English**
from the languages entry, naming the script rather than guessing a language from it
(Cyrillic is not Russian). And when a reader says *"that is chinese"* about a
message that arrived as Latin letters, the reply says so first — *"That came through
as random letters rather than Chinese,"* — then answers. The claim is checked against
what actually arrived, so a reader whose Chinese arrived intact is never told it
became random letters. The language named is **the reader's own word**, near-miss
corrected: *"chineese"* is a language claim, and a list of correctly spelled names
would throw it away.

The script helper reads the *script*, so a **French or Spanish question is not
detected** — Latin script cannot be told from English by character alone. That is a
known limit of this approach, and the languages entry is what covers it.

### The confidentiality guard

`RESTRICTED` is a request for private information about a specific individual —
the asker's own records or a named, identified or described other person's — in
any of these categories: salary, pay, bonus, payslip or any other figure about
compensation; performance reviews, ratings or improvement plans; disciplinary,
grievance or investigation records; health, the reason for leave, or personal and
family circumstances; an individual's contact details where they are not an
official company contact; termination or redundancy status.

It is decided **before retrieval**, and that ordering is the fix rather than a
detail. The refusal used to depend on the corpus holding something about the
person, and it never does: the documents are policies, not payroll, so "what is
Ama Konadu's salary?" found no chunks, was reported as a gap in the documents, and
sent the reader to HR over a question HR would not answer either.

It is enforced in two layers, and the order matters:

1. **Rules first**, in one editable block at the top of `app/rag/guard.py`: the
   asker's own records as before, plus third-party possessives, pronouns, roles,
   named people receiving something, and passives about a person ("who is being
   investigated"). No model call, and nothing the model can talk the guard out of.
2. **The classifier as the backstop**, for the phrasings no pattern anticipates —
   "how much does Kofi bank" is the same request as "what is Kwame's salary?" and
   matches no pattern. Name patterns are bypassed by rephrasing, so a guard made
   only of them is not a guard.

The guard is applied **again to the standalone query after a follow-up is
rewritten**, because "and his bonus?" is harmless-looking as a message and the
rewrite is what retrieval would receive. A follow-up to a refused turn stays
refused, however it is phrased.

What it must **not** refuse is the other half, and that is where the risk sits: a
previous bug refused a plain compensation paraphrase, so questions about how the
rules work stay answerable, including the ones that contain the same nouns.
"How is salary determined", "when is salary paid", "can I receive my salary before
the due date", "what are the leave entitlements", "how do I request a salary
review" and "what does the compensation policy cover" are all ordinary questions.
A capitalised word in a document title — "the Code of Conduct", "the Security
Policy" — is not a colleague, and an organisational possessive ("the company's
salary policy") is not a person's.

The notice is the same one for the asker's own records and a colleague's, and says
what is not shared rather than whether any record exists: "there is no record of
that" would answer the question the reader was refused.

### Continuing an answer

An expansion is never rewritten, because it names no subject, and a rewrite is
what made it fail. It is continued from the **documents this conversation's
answers have cited**, with every chunk the thread has already shown removed, so
the generator is handed what the reader has not seen yet. Chunk ids are derived
from the passage itself and stored with the citation, so this survives a reload
rather than working only in the tab that asked.

Those documents are read **whole, out of the store** — not out of the ranked
window the ordinary search returns. That distinction is the whole fix. As a
filter over the window, a continuation could only return passages the ordinary
search had already scored, so a thorough first answer used the window up and
"anything else?" reported a topic exhausted while unread sections of the same
document sat right there. A seven-section document now takes two expansions to
exhaust, and the count is logged every time:

```
expanding over 1 cited document(s): 7 chunks in them, 6 already shown, 1 remaining
```

That log is how `no_more_info` is known to be honest: "nothing left in them" and
"nothing matched" are the same reply, and only the numbers tell them apart.

**No `MIN_SCORE` floor on this path**, deliberately. A floor asks whether a chunk
is close enough to *this* question to be evidence for it, and this is not that
question: a section of a document the reader is already on is on topic by
membership of that document. Applying the floor would reintroduce the defect
above — an unread section that matches the original question weakly being
reported as though it had been read. The cap of three chunks, ordered by
similarity, is what keeps the answer focused instead.

When those documents are read out, the reply is `no_more_info`: *that covers
everything the documents say on this topic*. Not `not_found`, which claims the
corpus has a gap, and not a repeated search that finds the same passages again.

`no_more_info` is reachable **only from an answer**, and that is what the cited
documents decide: a turn that cited something read passages, and passages can be
exhausted. A turn that found nothing cited nothing, so the thread has no documents
at all, and *there is nothing left* would be a claim about documents that were never
opened. So "anything else?" after a `not_found` is answered instead with

> I didn't find anything on that, so I have nothing to add. You could rephrase it, or
> contact HR at hr@acmetech.example or +233 30 000 0000.

as a `conversational` turn, with **no search run at all**. The documents were never
found, so there is nothing to continue from; reporting the topic as exhausted would
be the second false claim about the same absence.

### Elaboration, which is the opposite of an expansion

`anything else?` and `anything about these departments?` both continue the documents
behind the last answer, and they want **opposite things** from them.

| | subject | passages already shown |
|---|---|---|
| **Expansion** — "anything else", "what else", "go on" | none named | held back |
| **Elaboration** — "anything about these…", "tell me about them", "explain that", "details on…" | the previous answer's subject | **included** |

Treated as one, the second was excluded from the very passage that holds its answer.
"how many departments do we have?" cited *Departments and their roles*, used it only
for the number ten, and displayed it — so the elaboration reader held it back and a
two-line answer about two of ten departments was the best the corpus could produce,
at a confidence of 3. Read as an elaboration, it is anchored on the previous
question plus the follow-up and nothing is held back, and it reads all ten out of
the one passage.

Detection is by rule, **before** the classifier, from a demonstrative with a noun
after it or an opener that carries the subject (*tell me about*, *explain*, *more
on*, *details about*). The classifier cannot be asked to do it: it sees the
conversation rather than the wording, so it reads both as a continuation of the same
topic. A bare demonstrative with nothing after it — *what else does that say* — is an
expansion, and the rule says so.

A topic-shifting follow-up keeps the rewrite, and if the rewrite retrieves nothing
the question it continues is tried in its place: a paraphrase is a worse handle on
the corpus than the question the reader actually asked. Only when that finds
nothing either is the turn a gap in the corpus.

### A message nobody can read

A keyboard accident is answered with the first of a small ladder, escalating as more
of them arrive in a row: a shrug the first time, two example questions the second,
patience after that. The count is read out of the conversation's stored messages
rather than remembered, so a reload changes neither number.

The rule is a **majority, not a single word**: a message is unreadable when at least
**60%** of its tokens are not words, after the allowlist of acronyms, corpus
vocabulary, names and pidgin. The old rule was "a familiar word exempts the
message", which "heyjffdk hdj this" defeated with its trailing *this*. It was
answered as a real message, so the **next** gibberish message in that conversation
was answered as though it were the first — the streak never started, and a reader
whose keyboard was broken got the shrug twice instead of the examples.

Sixty per cent is a majority on purpose, because the two errors are not equal: a
real question contains several ordinary words and clears the bar comfortably (*what
does the leave policy say* is one unknown of four), while anything typed by accident
is nearly all unknown by construction. A **single** word is judged by its shape
instead — *grievance* is in no word list, and a majority reading of one word is
meaningless, since it is 100% unknown whatever it is.

Only the retrieval path may report a gap in the corpus. That is the whole reason
each response carries a `kind` rather than an "answered: false": *not found* means
the documents do not cover an in-scope question, so HR can supply the missing
policy, and every other reply that cites nothing means something else — out of
scope was never something HR has an answer to, a conversational turn never asked,
a refusal was withheld on purpose, and a topic was finished rather than missing.

**Which chunks answer it?** Retrieval is hybrid (`app/rag/retrieval.py`). Vector
similarity and BM25 keyword matching each return candidates, and the two ranked
lists are merged by Reciprocal Rank Fusion — `1/(60 + rank)` per list, summed.
They cover opposite failures: vector search finds "annual leave" in a chunk headed
"Paid Time Off", and keyword search finds a chunk containing the literal "Code of
Conduct" that the vector search under-ranked. Fusing on *rank* rather than score
is what makes the merge possible, because cosine similarity and BM25 are not on
the same scale and cannot be averaged.

A chunk that only one search found still competes rather than being discarded —
that is the case worth having, and it is the exact-term hit the other search
buried. `grievance` is the live example: the vector search scores the right chunk
at 0.149, far under the floor, and the keyword half is what puts it in front of the
generator.

One rule qualifies that, because it is not obvious: **a keyword hit may only
rescue a chunk the vector search actually returned.** It need not score above
`min_score` — under-scoring is the case being rescued — but it must have been
considered. On a corpus this small, BM25's IDF is a weaker signal than it is over
a large document collection: a light verb appearing in four chunks scores as "rare"
as a policy name appearing in four. Left unchecked, "what do I get paid for my
work?" put the IT & VPN guide first on the strength of "get" and "work" alone —
terms whose similarity to that chunk is 0.163 — and the generator was handed a VPN
guide in answer to a question about pay. `min_score` does not catch it, because it
applies to what the vector search returned and that chunk was not returned at all.

`VECTOR_CANDIDATES` is therefore load-bearing beyond ranking: it is the window a
rescue may come from, so reducing it removes candidates rather than reordering
them. It must be at least 10 for this corpus — at `top_k`=4 the vector search only
ever saw four chunks, and `grievance` was not among them.

### Why `MIN_SCORE` was not lowered

Because on this embedding model the two cases cannot be separated by score. Best
chunk cosine, measured:

| | question | best cosine |
| --- | --- | --- |
| Answerable | What do I get paid for my work? | 0.307 |
| Answerable | How much do I earn? | 0.222 |
| Answerable | What is the notice period? | 0.269 |
| Unanswerable | How many dentists does the company have? | 0.323 |
| Unanswerable | What is the weather in Accra? | 0.295 |

The ranges overlap. Any threshold low enough to admit the answerable rows also
admits the unanswerable ones, and the corpus starts answering from the nearest
irrelevant document. A relative threshold ("at least 70% of the best score") was
implemented and measured: it produces **zero difference**, because it can only ever
lower the floor for a weak query — it can never admit a chunk the vector search
did not return.

So `MIN_SCORE` stays at 0.40 and `RECALL_FLOOR` handles the gap instead. When no
chunk clears `MIN_SCORE`, the best ones above `RECALL_FLOOR` are still handed to
the generator. The generator already decides `NOT_FOUND` when handed irrelevant
chunks — that is verified, not assumed — so the judgement goes where it can be
made well. A question with a real match above `MIN_SCORE` never reaches this path
at all, which is why no answer that works today changes.

`MIN_SCORE` and `KEYWORD_MIN_SCORE` are separate floors because the two scores are
not comparable. Raising either makes questions look "not found" with no error
anywhere, so change them with the corpus in mind.

### "Who is the head of the IT department?"

Asked because it answered `not_found`, which is either correct or a retrieval defect,
and the difference had to be established rather than assumed. **It is correct.**

**The corpus names no individual anywhere.** Every document carries an owning *team*
or office — `Owner: IT Support & Security`, `Owner: Office of the CTO`,
`Owner: People & Culture (HR)` — and a sweep of all 62 chunks for *head / lead /
director / chief / owner / manager* returns roles (*"your line manager"*, *"the
department head"*, as a step in a pay review) and offices, never a person. There is
no chunk that answers the question.

What retrieval returns for it, measured on the deployed corpus:

| chunk | cosine | BM25 |
| --- | --- | --- |
| IT & VPN Setup Guide > IT & VPN Setup Guide | **0.354** | 0.35 |
| Technical Departments & Tech Stack > Overview | 0.316 | 2.79 |
| Company Overview > Company Overview | 0.314 | 2.76 |
| Technical Departments > Technical Departments | 0.265 | 2.42 |

The best chunk is at 0.354, under `MIN_SCORE` of 0.40, and the keyword leg's higher
BM25 scores are the words *"IT"* and *"head"* matching document headers. **No floor
was touched.** There is no right chunk to lower a floor *for* — dropping `MIN_SCORE`
to 0.354 would admit those same passages and turn a correct gap into a confident
wrong answer about who runs a department.

It is pinned in the golden set's other half, `EXPECTED_GAPS`, next to the questions
that *should* retrieve something. A correct `not_found` is only correct while its
reason holds, so each entry carries the reason and the set fails if one of them ever
starts retrieving — which is the signal to add the document that answers it and
revisit the expectation.

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
| `title` | The conversation's name, sent once the first *question* has been answered — not on a greeting. |
| `error` | The answer could not be finished. Any partial text stays visible. |

`done` carries a required `kind` naming what the turn turned out to be, so a client
draws each outcome as its own thing rather than inferring it from the citations:

| `kind` | Meaning | Cites |
| --- | --- | --- |
| `answer` | Answered from the documents. | Yes |
| `not_found` | In scope, and the documents do not cover it. HR owns the gap. | No |
| `no_more_info` | "Anything else?" on a topic whose documents have been read out. Only reachable from an answer. Not a gap. | No |
| `out_of_scope` | A real request that was never something this assistant answers. | No |
| `conversational` | Not a request: a greeting, an acknowledgement, a remark, a question about the assistant. Also "anything else?" after a `not_found`, which has nothing to add. | No |
| `restricted` | A person's private records, the asker's or anybody else's. Not shared through here. | No |

`not_found` is produced by exactly one path — retrieval and generation for a real
in-scope question with no support in the documents — and it is the only kind that
may be drawn as "not found in company documents" with a route to HR attached.
Drawing any of the others that way is what made "there is no question" come back
as a false gap in the corpus.

Each citation carries a `chunk_id`: a hash of the document, section and text of
the passage, stable across restarts of the index. It is how a continuation knows
which passages it has already used, and it is stored with the message rather than
held in memory, so "anything else?" works the same after a reload.

**Only the passages the answer actually used are cited.** Retrieval returns the best
few regardless — it cannot know which the model will reach for — and displaying all
of them asserts support for parts of the answer nothing stands behind. "How many
departments do we have?" retrieved four passages and cited four; the number came
from one, and *Company size* and *Cross-cutting tools* were decoration.

So the generator is asked to report which passages it used, on a line after the
answer that `done` strips before anyone sees it:

```
There are ten departments.
USED: dc01fffb90892d9d
```

Those keys are validated against the passages that answer was actually given, and
an unknown key is discarded — a key that was never offered would be a citation
naming a passage the reader cannot be shown, and would then be held back from
"anything else?" on the strength of a passage that does not exist. If nothing
validates (a truncated stream, or a model that spent its budget thinking), the best
**two** by score are shown: an answer drawn with no evidence behind it is the one
outcome this must not produce.

The same set is what an expansion excludes, so "anything else?" never re-quotes a
passage the reader has read, and an elaboration — which wants more about the *same*
subject — can go back to the passage the previous answer only counted from.

Citations are then **numbered in display order**, with a document's passages kept
together. The client derives the number from array position and groups by document
on the card, so passages that alternate between two documents were displayed
*1, 3, 2*: the third belongs under the first document's heading. *Grounded in N
documents* is counted from the displayed passages only.

**No schema change was needed, and none was made.** The used passages are the
persisted ones, each marked `"used": true`, inside the `sources` JSON the column
already holds — so there is no migration, no nullable column and no second head.
Rows written before the flag existed hold every retrieved passage rather than only
the used ones; they load unchanged and their citations are treated as used, because
those passages *were* displayed and no migration can recover a distinction that was
never recorded.

`done` also carries the older `status` and `answered` for a client that has not
been redeployed, and every stored message carries both, so a thread written before
the upgrade still renders as what it was. `answered` now means exactly "a grounded
answer", which is the narrower and truer meaning of the word.

A client should treat an unrecognised `kind` as an ordinary reply rather than as a
failed search.

`done` also carries `confidence`: how closely the retrieved passages matched the
question, **1 to 10**, or `null`.

It is derived from the similarity of the best chunk that was retrieved, and it is
deliberately not a probability that the answer is right — nothing in the pipeline
knows that, since the figure is computed before the model is called at all. What it
reports is the quality of the evidence, which is why the two are separated: a
well-matched passage set that the model then answered wrongly still scores high,
and a correct answer drawn from a marginal match still scores low.

The scale is anchored on measurements from this corpus with this embedding model:
`RECALL_FLOOR` (0.15) at the bottom, and 0.70 at the top. So `MIN_SCORE` of 0.40
lands **mid-scale** — a good answer reports about 5/10, not 8/10. That reads low,
and it is the honest reading. `grievance` scores 1/10 because the chunk that
answers it has a cosine of 0.149: the answer is right and the match is marginal,
and the figure is about the second of those.

`null` is returned for every turn built from no passages — a conversational reply,
a refusal, an out-of-scope reply, or a question the corpus does not cover. Not `0`:
there was nothing to match, which is a different thing from matching badly, and a
low number beside an answer with no sources would read as a poor answer rather than
as the absence of one.

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

A conversation is named from the first message that was a real question, not from
the first message. A thread opened with "hey" stays "New conversation" until
something is asked of it, because naming it from a greeting is how a sidebar fills
with conversations called "Hey" that say nothing about what is in them.

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

The app serves its own `/api`, so `config.json` is `""` and the browser only ever
calls the app's address:

- `API_ORIGIN` on the app service is the backend, and is what the proxy forwards to.
- `ALLOWED_ORIGINS` and `CSRF_TRUSTED_ORIGINS` govern CORS and the CSRF origin
  check. The Express proxy rewrites the forwarded `Origin` to the backend's own, so
  on Render the app's origin does not have to be listed. They still matter for
  anything calling the backend directly — and for the Vercel rewrite, see below.
- `FRONTEND_BASE_URL` is where invitation links point.

`render.yaml` sets all of these, including `API_ORIGIN`. Nothing has to be read off
the service page after the first deploy, which is the point: an allow-list that has
to name the address you are already at is one more thing that can be wrong, and a
403 on the first write when it is.

### Do not set NODE_ENV=production on the frontend service

It breaks the build, in a way that looks like a broken toolchain rather than a
missing variable. `npm install` and `npm ci` both skip `devDependencies` when
`NODE_ENV=production`, and `@angular/cli` is one, so the install succeeds and quietly
removes the tool the build needs:

```
removed 263 packages, and audited 99 packages in 917ms
> ng build
sh: 1: ng: not found
```

Nothing in the server needs the variable — `API_ORIGIN` is read directly, so behaviour
is identical with and without it. `scripts/check_build_env.mjs` runs before the build
and explains this rather than leaving "command not found", but the fix is to leave
`NODE_ENV` unset.

### A 500 from every /api route means API_ORIGIN

The frontend serves `/api` itself, and if it cannot tell where the backend is, every
call in the app fails while the rest of the app looks fine — SSR and static assets
answer `200` because they never touch the proxy. That is a distinctive signature:

```
/api/auth/me           500
/api/conversations     500
/                      200
```

The service log holds the literal `API_ORIGIN is not set`. Note that a service created
before a key was added to `render.yaml` never receives it, because a blueprint only
applies env vars when it creates or re-syncs the service — so set it in the dashboard
and check the build command matches the blueprint's `npm ci && npm run build`.

## Deployment (Vercel)

The same app deploys to Vercel without a second code path. `frontend/vercel.json`
publishes the browser bundle and does the two jobs the Express server does on Render:

| Vercel route | What it does |
| --- | --- |
| `/api/:path*` | External rewrite to `https://knowledge-assistant-black.vercel.app/api/:path*` |
| `/(.*)` | SPA fallback to `/index.csr.html`, so client-side routes survive a refresh |

The rewrite is the important one. The browser still calls `/api` on the address the
page came from, so the session cookies stay first-party and `AUTH_COOKIE_SAMESITE`
can stay at `lax`. No CORS is involved, because from the browser's point of view
there is only one origin. Caching is disabled for the rewritten routes, since they
carry per-user responses and `Set-Cookie`.

SSR stays a Render feature: on Vercel the deployment is the static client bundle, so
the client-rendered routes are rendered on the client. The login screen is one of
them, which only means the first paint arrives a moment later than it does on Render.

### Frontend

1. Import the repo and set **Root Directory** to `frontend`, framework preset
   **Angular**.
2. Build command and output directory come from `frontend/vercel.json`
   (`npm run build`, `dist/frontend/browser`); leave the dashboard overrides empty.
3. No environment variables are required. `config.json` stays `""`, which points at
   the rewrite.

### Backend

Deploy `backend/` as a Python project, then set:

| Variable | Value |
| --- | --- |
| `ALLOWED_ORIGINS` | Include `https://internal-knowledge-assistant-fawn.vercel.app` |
| `CSRF_TRUSTED_ORIGINS` | Same origin, spelled exactly (scheme, host, no trailing slash) |
| `FRONTEND_BASE_URL` | `https://internal-knowledge-assistant-fawn.vercel.app` |
| `AUTH_COOKIE_SAMESITE` | `lax` — the rewrite makes the calls same-origin |

The origin entries are not optional on Vercel the way they are on Render. The Express
proxy rewrites `Origin` to the backend's own; a Vercel rewrite forwards the browser's
`Origin` unchanged, so the backend sees the frontend's address and compares it against
`CSRF_TRUSTED_ORIGINS`. Missing it fails the first write with
`403 ... which is not an allowed origin`, while reads and sign-in still look fine.

Preview deployment hostnames change per build, so either add the specific preview
origin you are testing or give the project a stable domain and trust that one.

### Switching the backend

The backend address appears in exactly two files:

- `frontend/vercel.json` — the `/api` rewrite `destination`, used by the Vercel app.
- `render.yaml` — `API_ORIGIN`, used by the Render app's Express proxy.

Change both when the API moves, and add the frontend origins to
`CSRF_TRUSTED_ORIGINS` on the backend. On a backend deployed somewhere that cannot
edit env vars, `ALLOWED_ORIGINS=*` with an empty `CSRF_TRUSTED_ORIGINS` makes the
origin check a no-op and leaves the double-submit token as the protection; it is a
deliberate trade, not the default.

## API Docs

Once running, interactive Swagger docs are available at:
- `http://localhost:8000/docs` (Swagger UI)
- `http://localhost:8000/redoc` (ReDoc)
