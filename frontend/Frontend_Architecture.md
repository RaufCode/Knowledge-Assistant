# Frontend Architecture and Coding Conventions
### Internal Knowledge Assistant — Angular v22

**Phase 2 note:** Authentication and the Admin panel are described at the end of this
file under Phase 2. They are now built and wired to a backend: `Phase_2_Authentication.md`
in the repository root is the design, and the section below records what the frontend
half of it became. Phase 1 itself is unchanged — the Dashboard, the Response view and
the conversation list — except that every route is now behind a session.

---

## 1. Technology Stack

- **Framework:** Angular v22, standalone components as the default (no NgModules)
- **Language:** TypeScript, strict mode enabled
- **Reactivity and state:** Signals as the primary reactive model, in line with Angular v22's signal-first architecture
- **Change detection:** OnPush by default across all components (the Angular v22 default)
- **Routing:** Angular Router, lazy-loaded route configuration
- **Styling:** Tailwind CSS (already added to the project), using AmaliTech brand colours defined as design tokens
- **HTTP layer:** Angular HttpClient, wrapped in dedicated services — never called directly from components

## 2. Brand Colours

Pull colours directly from AmaliTech's official brand assets. The values below are placeholders and must be replaced with the verified brand hex codes before building real screens.

- Primary: `[Insert verified AmaliTech primary colour hex — placeholder #0B5FA5]`
- Secondary / accent: `[Insert verified AmaliTech secondary colours]`
- Neutral palette: standard greys and white for backgrounds, text, and borders

Define these once as Tailwind theme tokens in `tailwind.config` rather than typing raw hex values across the codebase, so a brand colour change later means editing one file, not searching the whole project.

## 3. Architectural Approach: Signals and Standalone Components

- Every component is standalone. NgModules are not used anywhere in this project.
- Component state uses `signal()` for local reactive values and `computed()` for derived values. OnPush is left at its default, so templates update only when a signal they depend on actually changes.
- Shared, cross-cutting state (the current chat session, the list of past questions) lives in singleton services that expose signals, rather than being passed manually through many layers of components.
- No dedicated state management library is needed at this scale. Signals inside singleton services are sufficient and are the current recommended approach for small to medium Angular applications.

## 4. Project Structure (Phase 1)

```
src/
  app/
    app.config.ts
    app.routes.ts

    core/
      services/
        chat.service.ts
        history.service.ts
        api.service.ts
      models/
        message.model.ts
        question.model.ts

    shared/
      components/
        button/
          button.component.ts
        input/
          input.component.ts
        loading-indicator/
          loading-indicator.component.ts
      pipes/
      utils/
        format-date.util.ts
        constants.ts

    features/
      ask/
        components/
          question-input/
            question-input.component.ts
      response/
        components/
          answer-card/
            answer-card.component.ts
          source-tag/
            source-tag.component.ts
      history/
        components/
          history-list/
            history-list.component.ts
          history-item/
            history-item.component.ts

    views/
      dashboard-view/
        dashboard-view.component.ts
      response-view/
        response-view.component.ts
      history-view/
        history-view.component.ts
      app.routes.ts

  styles/
    main.css
  main.ts
```

## 5. Views and Routes (Phase 1)

| View | Route | Purpose |
|---|---|---|
| Dashboard View | `/` or `/ask` | Landing page. Shows the question input field. Submitting a question navigates to the Response view. |
| Response View | `/response/:id` | Shows the answer to the submitted question, with its cited source, and a loading state while the answer is being generated. |
| History View | `/history` | Lists past questions asked. Clicking a past entry opens its Response view. |

- Routes are declared in `app.routes.ts`, lazily loaded with `loadComponent` so each view's code is only downloaded when visited.
- Navigation flow: Dashboard → (submit question) → Response → (view past) → History → (click entry) → Response.

## 6. The Views Folder Rule

A view exists only to assemble the components its route needs and connect them to services. A view does not contain business logic, direct HTTP calls, or complex template markup of its own.

- A view imports the standalone components it needs from `features/` and `shared/`, and reads data through injected services.
- If a view file starts accumulating real logic, move that logic into a service or a feature component, and have the view simply call it.

## 7. Component Rules

- Every component is standalone and explicitly imports only what it uses.
- Shared, generic components with no business knowledge live under `shared/components` (button, input, loading indicator), and only receive data through inputs and communicate through outputs.
- Feature-specific components live under `features/<feature-name>/components`, grouped by the part of the application they belong to (ask, response, history).
- A component should have one clear responsibility. If a component's template grows past roughly 150 lines, or it handles more than one concern, split it.
- Components use `input()` and `output()` signal-based APIs rather than the older `@Input`/`@Output` decorators.

## 8. Naming Conventions

- **Component selectors:** kebab-case with a consistent prefix, e.g. `app-answer-card`
- **Component class names:** PascalCase with a `Component` suffix, e.g. `AnswerCardComponent`
- **Component file names:** kebab-case matching the class, e.g. `answer-card.component.ts`
- **Services:** PascalCase with a `Service` suffix in the class, kebab-case with `.service.ts` in the file, e.g. `ChatService` in `chat.service.ts`
- **Signals:** camelCase, named for the value they hold, not prefixed with the word "signal", e.g. `currentQuestion`, `isLoading`, `historyList`
- **Computed signals:** camelCase, named for what they represent, e.g. `hasHistory`, `formattedAnswer`
- **Booleans:** prefixed with `is`, `has`, or `can`, e.g. `isLoading`, `hasError`, `canSubmit`
- **Constants:** UPPER_SNAKE_CASE, e.g. `MAX_QUESTION_LENGTH`, `API_BASE_URL`
- **Route paths:** lowercase, kebab-case, e.g. `/history`, `/response`
- **Folders:** lowercase, grouped by feature rather than file type
- **Interfaces and models:** PascalCase, named for the entity without an `I` prefix, e.g. `Question`, `AnswerResponse`, `HistoryEntry`

## 9. Coding Conventions

- TypeScript strict mode is enabled project-wide. `any` is not used; `unknown` is used where a type genuinely isn't known ahead of time.
- All HTTP requests go through dedicated services in `core/services`. Components never inject `HttpClient` directly.
- A single shared base URL constant is defined once in `core`, never hardcoded per call.
- Errors from HTTP calls are handled centrally where possible (a shared error-handling utility or interceptor), and handled locally only where a specific, user-facing message is needed.
- Reactive forms are used for the question input, for validation control and testability.
- Every non-trivial function, service method, or signal that isn't self-explanatory carries a short comment.
- Templates avoid complex logic — conditional or transformation logic belongs in the component class as a computed signal or method.

## 10. Tailwind Styling Rules

- Utility classes only. No separate CSS files beyond the single `main.css` used to import Tailwind, and no scoped style blocks inside components.
- Repeated visual patterns (button styles, card styles) are pulled into a `shared/components` component rather than repeating long utility-class strings across the codebase.
- Responsive behaviour uses Tailwind's responsive prefixes (`sm:`, `md:`, `lg:`) consistently, not custom media queries.
- Brand colours are referenced through the Tailwind theme tokens defined in Section 2, never as raw hex values in component templates.

## 11. General Principles

- **Separation of concerns:** views assemble, feature components present and handle local interaction, services hold logic and shared state, utils hold small pure helper functions.
- **Single source of truth:** shared state (chat history, current question/answer) lives in exactly one service. Components read from that service's signals rather than keeping a duplicate local copy.
- **Lazy loading** is used for each view's route so the initial bundle only contains what's needed for the first screen.
- Every new component, service, or view follows the naming and folder rules above from the first commit.

---

## Phase 2: Authentication and Admin

Authentication is built and wired to the FastAPI backend described in
`../Phase_2_Authentication.md`. Accounts are invite-only: an administrator creates a
pending user and sends a link, the recipient sets a password, and from then on the
session is a pair of `httpOnly` cookies this app cannot read.

**Auth, as it is now:**

- **`login-view`** posts to `POST /api/auth/login` through `AuthService`. Reactive
  forms, with the validators kept as a UX layer: the server runs the same checks and
  is what decides. "Remember me" still keeps only the work email in `localStorage` —
  the session is a cookie the browser holds and this code cannot see, and storing a
  password to save a few keystrokes is the wrong trade either way.
- **`accept-invite-view`** reads `?token=` on load, asks `GET /api/auth/invite/{token}`
  what the invitation is for so the name and address fill themselves in, and posts
  the token and the password to `POST /api/auth/accept-invite`. The submission carries
  no name and no address: the account comes from the token server-side, and sending a
  second claim about who this is would be a way to disagree with it. Accepting signs
  the person in, so it lands in the app rather than back at the sign-in screen.
- **`register-view` is gone**, and `/register` redirects to `/accept-invite`. There is
  no self-registration behind it, so leaving a live "Create your account" form there
  was a form that could not succeed.
- **`AuthService`** holds the session as signals: `user`, `status`
  (`unknown` / `authenticated` / `anonymous`), `isAuthenticated`, `isAdmin`. `unknown`
  is the honest answer between page load and the first `GET /api/auth/me` returning,
  and it exists so a guard can wait rather than guess.
- **`core/guards/auth.guard.ts`** holds three guards: `authGuard`, `adminGuard` and
  `guestGuard`. They are a convenience and not the boundary — the backend refuses the
  same routes with a 401 or a 403, so a guard that was bypassed entirely would still
  not let anybody through.
- **`core/interceptors/auth.interceptor.ts`** attaches the CSRF header on
  state-changing requests, and on a 401 asks for one refresh and replays the request.
  Concurrent 401s share that refresh, because a second one would arrive after the
  first had already rotated the token and the server would read it as a replayed
  token and revoke the whole session.
- **`auth-layout`** no longer says that nothing typed on a signed-out screen is sent
  anywhere. It was true while the screens discarded their input and stopped being true
  the moment the form was wired to the backend.
- **Admin:** `admin-dashboard-view`, `admin-documents-view` and `admin-question-logs-view` under `views/`, with components under `features/admin/components/`. The three are now reached through one tab bar rather than two competing sets of link cards. The dashboard reports how recent questions ended and separates documents still indexing from ones that failed. Deleting and renaming act on a placeholder list in `core/data/mock-admin.data.ts` and say they did.
- **Uploads:** `document-dropzone` is a real drop target that also browses. It reads the file's own name and size and refuses an extension the design does not accept, all in the browser, so none of that needs a server. The progress bar is the exception and is marked as theatre in the code: nothing is transmitted, so it advances on a timer and the parent owns the message. A picked file enters the list as `processing`, since that is the state an upload passes through, and `PolicyDocument` keeps `uploadedAt` separately from `updatedAt` because when a file arrived and when it was last touched are different questions.
- **Question log review:** rows open `question-log-detail`, a right-hand drawer carrying the whole question, the answer as it was given, and the passages retrieval considered. `QuestionLog` therefore keeps `answer` and `sources` rather than a source count, because a log is only reviewable with them: a `not-found` entry holds the near-misses that missed the threshold, and a `failed` entry has no answer at all. Citations reuse `features/response/components/source-tag`, so a log and an answer show evidence identically. Marking a log reviewed and re-asking a question are stated as unconnected rather than offered as buttons that do nothing.
- **Roles:** `ViewerService` is gone. The role comes from the backend and lives in `AuthService` as a signal; `role-preview-toggle` went with it, because a role the server does not grant is not a role to preview. The sidebar link and the three admin views read `auth.isAdmin()`. An employee reaching an admin URL is redirected by `adminGuard`, and the `admin-access-required` panel remains as the second line of defence for a route reached while the app is already on screen.
- **Reusable pieces added for this work:** `app-badge`, `app-form-field`, `app-empty-state` and `app-confirm-dialog` under `shared/components/`. The dialog is a native `<dialog>`, so its focus trap and Escape handling come from the browser. `shared/utils/file-size.util.ts` formats a file size once for both the upload panel and the inventory row.

**The administrator role** is labelled "HR Administrator" on screen and is `admin` on
the wire. Initials are still stored per log entry rather than derived from the name,
which is how a rename once left stale initials in place.

**Getting an account.** Two ways in, and neither is a registration form:

- **`register-view`** is a *request* for access: a name and a work email, and nothing
  else. No password field, because there is nothing to set one with yet — an
  administrator reads the queue at `/admin/access` and approving it provisions the
  account and produces the invitation link. The request model on the backend has no
  `role` field, so a requester cannot name one; the role is set by whoever approves.
  A self-service form would let anyone who could type a colleague's address claim it,
  since a domain check only proves they typed it.
- **`admin-invite-view`** at `/admin/invite` is the other end: an administrator
  generates an invitation link for somebody directly.

  There is no mail service, so **the link is the deliverable**. Both admin screens
  show it with a Copy button and an "Open it" link for checking before sending, and
  say that it works once and expires. The administrator sends it by whatever means
  the company already uses. That is worse than an email and deliberately not a hidden
  one: nothing is queued and nothing silently dropped.

**Three things about auth in this codebase that are easy to get wrong**, each of
which cost a bug during this phase and each of which has a test:

- **`inject()` before any `await`.** A guard that resolves `AuthService` after a pause
  has already left the injection context and gets `NG0203`.
- **Nothing can be checked during a server render.** There are no cookies on a
  server, so both guards defer to the client. A render produces the shell and no data,
  and the guards run again with a real answer the moment the client takes over. This
  is also why `adminGuard` must not evaluate the role server-side: there is no user
  there, so it would read "not an administrator" for everybody and redirect every
  admin deep link to the dashboard.
- **`SameSite` is decided by host, not by port.** A page at `127.0.0.1:4200` calling
  `localhost:8099` is cross-site, and the browser withholds the session cookies:
  sign-in appears to work and every later request is a 401. `API_BASE_URL` and the
  host serving the app have to agree exactly. This is written up at the top of
  `core/api.config.ts` because it is the most likely way a deployment like this
  breaks silently.
- **`CSRF_TRUSTED_ORIGINS` has the same trap, and fails as a 403 rather than an
  error.** `localhost:4200` and `127.0.0.1:4200` are different origins to a browser,
  so an allow-list naming one rejects requests from the other — and the symptom is
  every state-changing request being refused, which reads as a broken interceptor
  rather than a misconfigured list.

**Still to build:**

- `document.service.ts` and a `question-log.service.ts`, replacing
  `mock-admin.data.ts`. The admin screens still act on a placeholder list; the
  document and question-log endpoints they need are not in the backend yet, and
  `require_admin` is written and tested so adding them is a one-line change per route.

**Where accounts are seeded.** `AUTH_SEED_ADMIN_EMAIL` / `AUTH_SEED_ADMIN_PASSWORD` in
`backend/.env` create an administrator at startup, which is how a fresh checkout
becomes usable without a shell. It is refused when `ENVIRONMENT=production`, the
password goes through the same policy as any other, and the two lines should be
removed once a real administrator exists.
- The streamed answer uses raw `fetch` rather than `HttpClient`, because `HttpClient`
  reads a response to completion and a stream has to be read as it arrives. It sets
  `credentials: 'include'` and the CSRF header itself, and handles its own one-time
  refresh on a 401 — the one request the interceptor does not see.
- The shell's plain-layout list in `app.component.ts` should become route data, once there are enough signed-out routes to justify it.

