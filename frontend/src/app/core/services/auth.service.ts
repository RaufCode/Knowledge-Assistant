import { isPlatformBrowser } from '@angular/common';
import { HttpBackend, HttpClient } from '@angular/common/http';
import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { Observable, catchError, firstValueFrom, map, of, tap, throwError } from 'rxjs';

import { ConfigService } from '../config.service';
import { IdentityService } from './identity.service';
import {
  AccessRequestDecisionDto,
  AccessRequestDecisionRequestDto,
  AccessRequestDto,
  AccessRequestListDto,
  AccessRequestSubmittedDto,
  ChangeOwnPasswordRequestDto,
  CreateAccountRequestDto,
  PasswordResetRequestDto,
  PendingApprovalDto,
  UserListDto,
  UserSummaryDto,
  UserUpdateRequestDto,
} from '../models/access-request.model';
import {
  AcceptInviteRequestDto,
  CsrfResponseDto,
  InvitePreviewDto,
  LoginRequestDto,
  Role,
  UserDto,
  UserResponseDto,
} from '../models/auth.model';

/** Name of the CSRF cookie, which is the one cookie this app is allowed to read. */
const CSRF_COOKIE = 'ika_csrf';

/**
 * Name of the readable flag saying "this browser probably has a session".
 *
 * Set by the backend next to the session cookies, carrying nothing of value and
 * carrying no token. It exists so this app can tell, without a round trip, whether
 * asking who somebody is is worth doing.
 */
const SESSION_HINT_COOKIE = 'ika_session';

/** Header the CSRF cookie's value has to come back in. */
export const CSRF_HEADER = 'X-CSRF-Token';

/**
 * Remembers, on this origin, that a session was established here.
 *
 * The readable hint cookie cannot do this job on its own: it is set on the
 * API's host, and frontend JavaScript on another host can never see it — which
 * is every production deploy, where app and API are different sites. Without
 * this flag, every page reload concluded "no session" without asking and sent
 * a signed-in person back to the sign-in screen, even with a perfectly good
 * session sitting in the cookie jar.
 *
 * A flag, not a credential: its only effect is licensing one `GET /me`, whose
 * answer is what decides. Setting it wrongly buys nothing but a refused
 * request, and a refused request settles back to signed out on its own.
 */
const KNOWN_SESSION_KEY = 'knowledge-assistant.session';

/**
 * The last confirmed signed-in person, as plain JSON.
 *
 * Only the user object — id, name, email, role — never a token. Tokens live in
 * `httpOnly` cookies and are never readable here, so there is nothing secret to
 * steal out of this entry. Its only job is making a reload instant: without it,
 * every refresh starts from "unknown" and must wait for `GET /me` before the
 * guards may render, which is the frame where the wrong screen could appear.
 * With it, the shell renders the right page immediately and the network only
 * confirms what is already on screen.
 *
 * `localStorage`, not `sessionStorage`: a new tab is the same browser with the
 * same cookies, so it should open signed in rather than ask again. Cleared the
 * moment the user is cleared, so signing out never leaves a stale snapshot that
 * a later reload would briefly render as somebody.
 */
const CACHED_USER_KEY = 'knowledge-assistant.user';

/**
 * Where the app stands on authentication, which is not the same as not being signed
 * in.
 *
 * `unknown` is the honest answer between page load and the first `GET /api/auth/me`
 * returning, and it exists so a guard can wait rather than guess. Guessing would
 * either flash the sign-in screen at somebody who is signed in, or let a signed-out
 * visitor see a frame of the dashboard before it decided to redirect.
 */
export type AuthStatus = 'unknown' | 'authenticated' | 'anonymous';

/**
 * Who is signed in, and the four things that can change it.
 *
 * The session itself lives entirely in `httpOnly` cookies. This service cannot read
 * a token, cannot put one in storage, and has no expiry to track — which is why
 * there is no countdown to a silent refresh anywhere in the app. When the access
 * token runs out, the next request comes back 401, and `authInterceptor` handles
 * that by refreshing and replaying. That is less clever than scheduling a refresh
 * against a known expiry, and it is the only option that works without the token
 * ever being visible to this code.
 *
 * `user` is a signal so the guards, the sidebar and the role-gated views all react
 * to the same single value rather than each holding a copy that can disagree.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly config = inject(ConfigService);

  /**
   * The backend without the interceptor.
   *
   * Used only for checks that must not trigger session machinery: proving the
   * cookies round-trip must neither refresh nor end the session it is
   * inspecting, which is exactly what the interceptor would do with a 401.
   */
  private readonly raw = new HttpClient(inject(HttpBackend));

  private readonly userState = signal<UserDto | null>(null);
  private readonly statusState = signal<AuthStatus>('unknown');
  private readonly identity = inject(IdentityService);

  constructor() {
    // Restored synchronously so the first render already knows who is signed
    // in. Without this, a refresh always starts from "unknown", blocks the
    // router on a network round trip, and the sign-in screen can appear for a
    // frame before the real page arrives. The snapshot is never trusted for
    // decisions — `maybeBootstrap` still revalidates against the backend, and
    // the backend still refuses unauthenticated data with 401/403.
    const cached = this.readCachedUser();

    if (cached) {
      this.userState.set(cached);
      this.statusState.set('authenticated');
      this.identity.bindToAccount(cached.id);
    }
  }

  private get baseUrl(): string {
    return this.config.getApiBaseUrl();
  }

  /** The signed-in person, or null. */
  readonly user = this.userState.asReadonly();

  /** Where the app stands on authentication. */
  readonly status = this.statusState.asReadonly();

  /** Whether somebody is signed in and the backend has confirmed it. */
  readonly isAuthenticated = computed(() => this.statusState() === 'authenticated');

  /** Whether the signed-in person may reach the admin-only routes. */
  readonly isAdmin = computed(() => this.userState()?.role === 'admin');

  /**
   * Whether somebody is signed in whose role is not `admin`.
   *
   * Deliberately not `!isAdmin()`. That is also true while nobody is signed in, and
   * the administration screens used the difference to tell a refusal apart from a
   * blank page — so a signed-out visitor arriving on one was told their account did
   * not have administrator access, which is a different claim entirely: nothing had
   * been decided about an account, because there was not one to decide about.
   *
   * Answering "nobody" instead is what lets the guard send them to sign in, which is
   * where that answer belongs. The screen says nothing until there is somebody to
   * refuse.
   */
  readonly lacksAdminAccess = computed(() => this.isAuthenticated() && !this.isAdmin());

  /**
   * Where somebody lands after signing in, which depends on their role.
   *
   * An administrator lands on the dashboard, because their job starts there. An
   * employee lands on the assistant, which is the whole of what they can see.
   *
   * Held here rather than decided at each call site, because there are four of them
   * — sign-in, accepting an invitation, the guest guard and the sign-out path — and
   * four copies of "where does this person go" is four chances for an administrator
   * to be dropped into a chat screen instead.
   */
  readonly landingPath = computed(() => (this.isAdmin() ? '/admin' : '/'));

  /**
   * Where to reach the assistant deliberately.
   *
   * A separate path from `landingPath`, and only because the front door now turns
   * administrators away: `/` is where an administrator is redirected *from*, so a
   * link to the assistant cannot point there or it would bounce straight back. An
   * employee has no such redirect, but they are given this path too rather than a
   * bare `/` so that one link works for both roles and there is a single place that
   * knows which route reaches the assistant.
   */
  readonly assistantPath = computed(() => (this.isAdmin() ? '/ask' : '/'));

  /**
   * The one `GET /api/auth/me` per app load, however many callers ask for it.
   *
   * Shared as a promise rather than left to each caller: the route guard and the
   * app shell both need to know, and two calls could disagree if one landed before
   * sign-in and the other after it.
   */
  private bootstrapPromise: Promise<UserDto | null> | null = null;

  /** The in-flight refresh, shared so concurrent 401s cause one refresh, not several. */
  private refreshPromise: Promise<UserDto | null> | null = null;

  /**
   * Counts the sessions this tab has ended, so an answer already on its way can tell
   * whether it still describes anything.
   *
   * A `GET /me` cannot be taken back. It is fired while a session is believed to
   * exist and answered whenever the network gets round to it, so signing out in
   * between does not stop it arriving — it arrives with a user in it and puts the
   * person back. That is not hypothetical here: changing an administrator's own
   * password revokes every session server-side while leaving the access token good
   * for up to fifteen minutes, so the request a guard had already sent came back
   * with the administrator in it, minutes after they had asked to be signed out.
   *
   * A request notes the count it was sent under and drops its own answer if the
   * count has moved on. The answer is not wrong about who that was; it is wrong
   * about who is signed in now.
   */
  private sessionEpoch = 0;

  /**
   * Whether the question can even be asked here.
   *
   * False during a server render. The session lives in cookies the browser holds, so
   * there is nothing to check on the server and any answer would be a guess.
   */
  isBrowserOnly(): boolean {
    return this.isBrowser;
  }

  /**
   * Whether this browser looks like it has a session, judged without a request.
   *
   * Two hints, because neither covers every deploy. The readable cookie the
   * backend sets beside the session cookies answers on a same-host setup, where
   * frontend JavaScript can actually read the API's cookies. The remembered flag
   * in storage answers everywhere else: it is written on this origin the moment
   * a session is established, so a cross-site deploy still asks rather than
   * concluding "signed out" on every reload. Both prove nothing on their own —
   * the answer here is only ever "worth asking", never "signed in".
   *
   * Why this exists: without it, every signed-out visit to the sign-in screen had to
   * call `GET /api/auth/me` in order to be told it was not signed in. That is a
   * request for somebody's user details, made by somebody who has not signed in,
   * before they have signed in — and it failed, noisily, on the page least likely
   * to want a failure.
   */
  looksSignedIn(): boolean {
    if (!this.isBrowser) {
      return false;
    }

    if (this.hasKnownSession()) {
      return true;
    }

    if (this.readCachedUser() !== null) {
      return true;
    }

    return document.cookie
      .split(';')
      .some((pair) => pair.trim().startsWith(`${SESSION_HINT_COOKIE}=`));
  }

  /**
   * Whether a session was established in this browser, as remembered here.
   *
   * Storage, not cookies, because this origin's storage is readable on every
   * deploy while the API's cookies are only readable same-host. Best effort: a
   * browser that refuses storage simply loses this hint, exactly as if no
   * session had been established.
   */
  private hasKnownSession(): boolean {
    if (!this.isBrowser) {
      return false;
    }

    try {
      return localStorage.getItem(KNOWN_SESSION_KEY) !== null;
    } catch {
      return false;
    }
  }

  /**
   * Settles the session, asking the backend only if it looks worth asking.
   *
   * The entry point the guards use. When there is no hint cookie the answer is
   * "signed out" with no network call at all, which is the ordinary case on the
   * signed-out screens and the reason those screens no longer talk to the API.
   *
   * When there is a hint — a returning visitor, or somebody who has just signed in
   * and had their session rotated — it asks, because at that point the answer
   * changes what gets rendered and there is no way to know it locally.
   */
  async maybeBootstrap(): Promise<UserDto | null> {
    if (!this.looksSignedIn()) {
      // Recorded rather than left unknown, so a guard waiting on this does not wait
      // for an answer that is not coming.
      if (this.statusState() === 'unknown') {
        this.statusState.set('anonymous');
      }

      return null;
    }

    return this.bootstrap();
  }

  /**
   * Finds out who is signed in, once, by asking.
   *
   * Prefers `maybeBootstrap`, which skips the request when there is plainly no
   * session. Shared as a promise rather than left to each caller: the route guard
   * and the app shell both need to know, and two calls could disagree if one landed
   * before sign-in and the other after it.
   *
   * Does nothing on the server. The session is a pair of cookies in the browser and
   * a server render has neither them nor the `document` the hint is read out of, so
   * there is no question to answer there — only a round trip that could not succeed
   * anyway. The guards treat that as "defer to the browser".
   */
  bootstrap(): Promise<UserDto | null> {
    if (this.bootstrapPromise) {
      return this.bootstrapPromise;
    }

    if (!this.isBrowser) {
      return Promise.resolve(null);
    }

    const epoch = this.sessionEpoch;

    this.bootstrapPromise = firstValueFrom(
      this.http.get<UserDto>(`${this.baseUrl}/api/auth/me`, this.credentials()).pipe(
        // The epoch is what makes a signed-out-in-the-meantime answer harmless: the
        // person it names is no longer signed in, and setting them would undo that.
        tap((user) => {
          if (this.sessionEpoch === epoch) {
            this.setUser(user);
          }
        }),
        // A 401 here means the access cookie has expired, not necessarily that the
        // session is over: the access token is deliberately short-lived and the
        // refresh cookie outlives it. So one refresh is tried before concluding
        // anything.
        //
        // Without this the browser sat in a loop it could not leave. The hint cookie
        // said "worth asking", `/me` said 401, and the hint survived — so every
        // reload asked again and got the same answer, for as long as the hint cookie
        // lived. Clearing it is what stops the asking.
        catchError(() => this.recoverFromExpiredAccess()),
      ),
    ).then((user) => {
      // The CSRF token is fetched whether or not anybody is signed in: the sign-in
      // and accept-invite forms are exempt from the check server-side, but every
      // later state-changing request needs one, and issuing it now means the first
      // question asked after signing in does not have to wait for it.
      this.loadCsrfToken();

      return user;
    });

    return this.bootstrapPromise;
  }

  /**
   * Trades an expired access cookie for a new one, and gives up cleanly if it cannot.
   *
   * Returns the user on success and null when the session really is over, in which
   * case the hint cookie is cleared so the next load does not ask again.
   */
  private async recoverFromExpiredAccess(): Promise<UserDto | null> {
    const user = await this.refresh();

    if (user === null) {
      this.forgetSessionHint();
    }

    return user;
  }

  /**
   * Proves the session cookies round-trip, right after signing in.
   *
   * A successful sign-in only proves the password was right: the session itself
   * lives in cookies the browser has to keep and send back, and on some setups
   * it does neither — third-party cookies blocked, for instance. Without this
   * check the app navigates in as though everything worked and is bounced back
   * to the sign-in screen seconds later, when the first authenticated call
   * finds no session to speak of. Emits false in exactly that case, so the
   * caller can say what is wrong instead of looping.
   *
   * Asked past the interceptor on purpose: a refusal here must not refresh or
   * end the session it is inspecting, which is what the interceptor would do
   * with it. Anything that is not a refusal — the backend unreachable — is left
   * for the caller to decide, because a failed check is not a failed session.
   */
  verifySession(): Observable<boolean> {
    if (!this.isBrowser) {
      return of(false);
    }

    return this.raw
      .get<UserDto>(`${this.baseUrl}/api/auth/me`, this.credentials())
      .pipe(
        map(() => true),
        catchError((error: unknown) =>
          (error as { status?: number } | null)?.status === 401
            ? of(false)
            : throwError(() => error),
        ),
      );
  }

  /**
   * Removes the readable hint, so a signed-out browser stops looking signed in.
   *
   * The hint is only ever a hint — it decides whether asking is worth it and is never
   * sent as proof of anything — so deleting it here cannot sign anybody out. It only
   * stops the app asking a question whose answer it already has.
   *
   * The attributes have to match the ones the server set it with, or the browser
   * treats it as a different cookie and leaves the original in place.
   */
  private forgetSessionHint(): void {
    if (!this.isBrowser) {
      return;
    }

    document.cookie = `${SESSION_HINT_COOKIE}=; path=/; max-age=0; samesite=lax`;
  }

  /**
   * `POST /api/auth/login`.
   *
   * Emits `null` for an account that exists but is not switched on, which is a real
   * answer and not a failure: the password was right, the account is simply waiting on
   * an administrator. The caller shows the pending screen from it.
   *
   * Nothing is stored on that answer. No session cookie came with it and no user is
   * set, so a pending account cannot be mistaken for a signed-in one anywhere else in
   * the app.
   */
  login(email: string, password: string): Observable<UserDto | null> {
    const body: LoginRequestDto = { email: email.trim(), password };

    return this.http
      .post<UserResponseDto | PendingApprovalDto>(
        `${this.baseUrl}/api/auth/login`,
        body,
        this.credentials(),
      )
      .pipe(
        map((response) => {
          if ('user' in response) {
            return response.user;
          }

          this.pendingState.set(response);

          if (this.isBrowser) {
            document.cookie = `ika_pending=${btoa(
              JSON.stringify(response),
            )}; path=/; samesite=lax; max-age=86400`;
          }

          return null;
        }),
        tap((user) => {
          if (user) {
            this.pendingState.set(null);
            if (this.isBrowser) {
              document.cookie = `ika_pending=; path=/; max-age=0; samesite=lax`;
            }
            // Approved since the request was made: nothing left to wait on.
            this.forgetAccessRequest(user.email);
            this.setUser(user);
            // Sign-in rotates the CSRF cookie server-side, so the one held here is no
            // longer the one the server expects.
            this.loadCsrfToken();
          }
        }),
      );
  }

  private readonly pendingFromCookie = (): PendingApprovalDto | null => {
    if (!this.isBrowser) {
      return null;
    }

    const match = document.cookie.match(
      /(^|;\s*)ika_pending=([^;]*)/,
    );

    if (!match) {
      return null;
    }

    try {
      return JSON.parse(atob(match[2]));
    } catch {
      return null;
    }
  };

  private readonly pendingState = signal<PendingApprovalDto | null>(
    this.isBrowser ? this.pendingFromCookie() : null,
  );

  /** Re-reads the pending cookie and updates the signal if the cookie exists. */
  refreshPendingFromCookie(): void {
    if (!this.isBrowser) {
      return;
    }

    const data = this.pendingFromCookie();
    if (data) {
      this.pendingState.set(data);
    }
  }

  /**
   * What the last sign-in said about a request still waiting.
   *
   * Held on the service rather than in the navigation, so a refresh on the pending
   * screen reads the same answer instead of arriving blank. Nothing about it is ever
   * put in the URL: none of it belongs in an address bar.
   */
  readonly lastPending = this.pendingState.asReadonly();

  /** Local store for access requests made in this browser. */
  private static readonly PENDING_REQUEST_KEY = 'ika_pending_request';

  /** Remembers an access request made here, so a later sign-in can explain a refusal.
   *
   * The backend answers a correct sign-in for an unapproved account exactly as it
   * answers a wrong password, so without this memory there is no telling the two
   * apart. What is stored is only what the person typed moments ago on this same
   * browser — never anything the server confirmed — which bounds what it can say.
   */
  private rememberAccessRequest(name: string, email: string, role: Role): void {
    if (!this.isBrowser) {
      return;
    }

    try {
      localStorage.setItem(
        AuthService.PENDING_REQUEST_KEY,
        JSON.stringify({ name: name.trim(), email: email.trim().toLowerCase(), role }),
      );
    } catch {
      // Remembering is a courtesy. A browser that refuses storage still gets the
      // generic refusal rather than a second failure about remembering.
    }
  }

  /** The access request remembered for this address, if it was made here. */
  pendingRequestFor(email: string): { name: string; role: Role } | null {
    if (!this.isBrowser) {
      return null;
    }

    try {
      const raw = localStorage.getItem(AuthService.PENDING_REQUEST_KEY);

      if (!raw) {
        return null;
      }

      const stored = JSON.parse(raw) as { name?: unknown; email?: unknown; role?: unknown };

      if (typeof stored.email !== 'string' || stored.email !== email.trim().toLowerCase()) {
        return null;
      }

      return {
        name: typeof stored.name === 'string' ? stored.name : '',
        role: stored.role === 'admin' ? 'admin' : 'employee',
      };
    } catch {
      return null;
    }
  }

  /** Forgets the remembered request, once its account signs in. */
  private forgetAccessRequest(email: string): void {
    if (!this.isBrowser) {
      return;
    }

    try {
      const raw = localStorage.getItem(AuthService.PENDING_REQUEST_KEY);

      if (raw) {
        const stored = JSON.parse(raw) as { email?: unknown };

        if (stored.email === email.trim().toLowerCase()) {
          localStorage.removeItem(AuthService.PENDING_REQUEST_KEY);
        }
      }
    } catch {
      // Best effort, as above.
    }
  }

  /**
   * Shows the waiting screen for a request remembered from this browser.
   *
   * For a backend that distinguishes "right password, not approved" with its own
   * answer, this never runs — that answer carries the person's verified details.
   * Here the details are what was typed at registration, which is all there is.
   */
  notePendingAccess(name: string, role: Role | null): void {
    const dto: PendingApprovalDto = { status: 'pending', name, requested_role: role };
    this.pendingState.set(dto);

    if (this.isBrowser) {
      document.cookie = `ika_pending=${btoa(JSON.stringify(dto))}; path=/; samesite=lax; max-age=86400`;
    }
  }
  previewInvite(token: string): Observable<InvitePreviewDto> {
    return this.http.get<InvitePreviewDto>(
      `${this.baseUrl}/api/auth/invite/${encodeURIComponent(token)}`,
      this.credentials(),
    );
  }

  /** `POST /api/auth/accept-invite`. Sets the password and signs the person in. */
  acceptInvite(token: string, password: string): Observable<UserDto> {
    const body: AcceptInviteRequestDto = { token, password };

    return this.http
      .post<UserResponseDto>(`${this.baseUrl}/api/auth/accept-invite`, body, this.credentials())
      .pipe(
        map((response) => response.user),
        tap((user) => {
          this.setUser(user);
          this.loadCsrfToken();
        }),
      );
  }

  /**
  /**
   * `POST /api/auth/request-access`. Asks an administrator for an account.
   *
   * Creates a request and nothing else: no account exists until somebody approves
   * one. That is what makes this safe to leave open, where a plain registration form
   * would let anyone who could type a colleague's address claim it.
   *
   * A CSRF header is attached to it by the interceptor, unlike signing in. There is
   * nothing here that needs an exemption — the token comes from a public endpoint and
   * the frontend has one before this screen is reachable — so requiring it costs
   * nothing and closes a way to fill an administrator's queue from another site.
   */
  /**
   * `POST /api/auth/request-access`. Registers, and asks for access in one step.
   *
   * The role is what the person is asking for and nothing more; the role they are
   * given is decided by whoever approves the request.
   */
  requestAccess(
    name: string,
    email: string,
    role: Role,
    password: string,
  ): Observable<AccessRequestSubmittedDto> {
    const body: AccessRequestDto = { name: name.trim(), email: email.trim(), role, password };

    return this.http.post<AccessRequestSubmittedDto>(
      `${this.baseUrl}/api/auth/request-access`,
      body,
      this.credentials(),
    ).pipe(
      tap(() => this.rememberAccessRequest(name, email, role)),
    );
  }

  /**
   * `POST /api/auth/accounts`. Administrators only.
   *
   * Creates the account outright, with a password chosen here rather than one the
   * person sets for themselves. That is what makes it the only flow available when
   * there is no mail service to deliver an invitation with, and it is the weaker of
   * the two: from this point the administrator knows the password and could sign in
   * as the person they created. The role is decided here and nowhere else, exactly as
   * it is for an invitation.
   */
  createAccount(name: string, email: string, role: Role, password: string): Observable<UserDto> {
    const body: CreateAccountRequestDto = { name: name.trim(), email: email.trim(), role, password };

    return this.http
      .post<UserResponseDto>(`${this.baseUrl}/api/auth/accounts`, body, this.credentials())
      .pipe(map((response) => response.user));
  }

  /**
   * `GET /api/auth/users`. Administrators only.
   *
   * A page at a time, with the page count alongside, so the pager cannot disagree
   * with the server about how many accounts there are.
   */
  listUsers(page: number): Observable<UserListDto> {
    return this.http.get<UserListDto>(
      `${this.baseUrl}/api/auth/users?page=${page}`,
      this.credentials(),
    );
  }

  /** `PATCH /api/auth/users/{id}`. Corrects an account. Administrators only. */
  updateUser(
    userId: string,
    changes: UserUpdateRequestDto,
  ): Observable<UserSummaryDto> {
    return this.http.patch<UserSummaryDto>(
      `${this.baseUrl}/api/auth/users/${encodeURIComponent(userId)}`,
      changes,
      this.credentials(),
    );
  }

  /** `DELETE /api/auth/users/{id}`. Administrators only. */
  deleteUser(userId: string): Observable<void> {
    return this.http
      .delete<void>(
        `${this.baseUrl}/api/auth/users/${encodeURIComponent(userId)}`,
        this.credentials(),
      )
      .pipe(map(() => undefined));
  }

  /**
   * `POST /api/auth/users/{id}/password`. Administrators only.
   *
   * Sets a new password for somebody locked out, and revokes every session they
   * have open with it. Returns nothing: the password is not echoed back, so the
   * only copy is the one the administrator typed.
   */
  resetPassword(userId: string, password: string): Observable<void> {
    const body: PasswordResetRequestDto = { password };

    return this.http
      .post<void>(
        `${this.baseUrl}/api/auth/users/${encodeURIComponent(userId)}/password`,
        body,
        this.credentials(),
      )
      .pipe(map(() => undefined));
  }

  /**
   * `POST /api/auth/me/password`. Changes the signed-in person's own password.
   *
   * Any role, unlike `resetPassword` above: the current password proves
   * possession, so a session left open cannot be used to lock its owner out. The
   * backend revokes every session with it, so the caller signs out afterwards
   * and the new password is what signs back in.
   */
  changeOwnPassword(currentPassword: string, newPassword: string): Observable<void> {
    const body: ChangeOwnPasswordRequestDto = {
      current_password: currentPassword,
      new_password: newPassword,
    };

    return this.http
      .post<void>(`${this.baseUrl}/api/auth/me/password`, body, this.credentials())
      .pipe(map(() => undefined));
  }

  /** `GET /api/auth/requests`. Administrators only. */
  listAccessRequests(): Observable<AccessRequestListDto> {
    return this.http.get<AccessRequestListDto>(
      `${this.baseUrl}/api/auth/requests`,
      this.credentials(),
    );
  }

  /**
   * `POST /api/auth/requests/{id}/approve`. Administrators only.
   *
   * The role is decided here and nowhere else: the person who asked could not set
   * one, so this is the only place an administrator role can come into being.
   */
  approveAccessRequest(requestId: string, role: Role): Observable<AccessRequestDecisionDto> {
    const body: AccessRequestDecisionRequestDto = { role };

    return this.http.post<AccessRequestDecisionDto>(
      `${this.baseUrl}/api/auth/requests/${encodeURIComponent(requestId)}/approve`,
      body,
      this.credentials(),
    );
  }

  /** `POST /api/auth/requests/{id}/decline`. Administrators only. */
  declineAccessRequest(requestId: string): Observable<AccessRequestDecisionDto> {
    return this.http.post<AccessRequestDecisionDto>(
      `${this.baseUrl}/api/auth/requests/${encodeURIComponent(requestId)}/decline`,
      {},
      this.credentials(),
    );
  }

  /**
   * `POST /api/auth/refresh`. Trades the refresh cookie for a new pair.
   *
   * Returns null rather than throwing when the refresh is refused: a refused
   * refresh means the session is over, which the caller handles by sending the
   * person to the sign-in screen, not by surfacing an error they could do
   * anything about. Anything else — the backend unreachable, asleep, or
   * erroring — is rethrown untouched: a network failure is not a session that
   * ended, and treating it as one signed people out for trying to use the app
   * while the backend was waking up.
   */
  refresh(): Promise<UserDto | null> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    const epoch = this.sessionEpoch;

    this.refreshPromise = firstValueFrom(
      this.http
        .post<UserResponseDto>(`${this.baseUrl}/api/auth/refresh`, {}, this.credentials())
        .pipe(
          map((response) => response.user),
          // Same reasoning as `bootstrap`: a refresh that was asked for before the
          // session ended must not bring it back afterwards.
          tap((user) => {
            if (this.sessionEpoch === epoch) {
              this.setUser(user);
            }
          }),
          catchError((error: unknown) => {
            if (isSessionRefusal(error)) {
              this.setUser(null);
              return of(null);
            }

            return throwError(() => error);
          }),
        ),
    ).finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  /** `POST /api/auth/logout`. Ends the session server-side, then locally. */
  logout(): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/api/auth/logout`, {}, this.credentials()).pipe(
      // The local session is ended even if the request failed. The user asked to
      // sign out, and leaving them apparently signed in because a network call
      // timed out would be the worse of the two answers.
      tap(() => this.setUser(null)),
      catchError(() => {
        this.setUser(null);
        return of(undefined);
      }),
      map(() => undefined),
    );
  }

  /** The CSRF token, as the backend last echoed it in a response body.
   *
   * Held in memory rather than read out of the cookie, because this app and the
   * API are on different hosts and frontend JavaScript can never see the API's
   * cookies: `document.cookie` only holds this origin's own. The browser still
   * sends the cookie with every credentialed request (which is the half the
   * server compares against); this is the half that goes in the header.
   *
   * The `/csrf` endpoint echoes the token it just set precisely so callers that
   * cannot read the cookie do not have to.
   */
  private csrfMemory: string | null = null;

  /** The CSRF token to send with a state-changing request, or null if there is none.
   *
   * Memory first, cookie as fallback (same-host development, where the cookie is
   * readable and no body token may have been fetched yet).
   */
  readCsrfToken(): string | null {
    if (this.csrfMemory) {
      return this.csrfMemory;
    }

    if (!this.isBrowser) {
      return null;
    }

    for (const part of document.cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=');

      if (name === CSRF_COOKIE) {
        return decodeURIComponent(rest.join('='));
      }
    }

    return null;
  }

  /**
   * Forgets the current user without touching the server.
   *
   * Also stops the app asking about a session it has just decided is over. The hint
   * cookie outlives this call — it is the backend's to clear, and it only gets
   * cleared when the revocation that follows lands — so without dropping it here a
   * guard asked in the meantime would answer `/me`, and the access token that
   * request carries is still good for up to fifteen minutes after its sessions were
   * revoked. That is how signing out locally could put an administrator straight back
   * on an admin screen, signed out of the account but with the page drawn for one.
   */
  clear(): void {
    this.forgetSessionHint();
    this.setUser(null);
  }

  /**
   * Marks the session gone.
   *
   * The bootstrap promise is cleared as well as the user: it resolved to "signed
   * out", and holding onto that answer would make the next guard that asks bounce
   * straight to the sign-in screen without ever re-checking a cookie that may since
   * have arrived.
   */
  private setUser(user: UserDto | null): void {
    // Bumped on every ending, never on a sign-in, so it counts sessions ended rather
    // than requests sent. `bootstrap` and `refresh` compare against it and drop an
    // answer that belongs to a session which is already over.
    if (user === null) {
      this.sessionEpoch += 1;
    }

    this.userState.set(user);
    this.statusState.set(user ? 'authenticated' : 'anonymous');
    // Threads belong to the account that made them: point the browser at this
    // account's own id (or back at the anonymous one) so no account ever opens
    // another's conversations on a shared browser.
    this.identity.bindToAccount(user?.id ?? null);
    this.rememberSession(user !== null);
    this.cacheUser(user);

    if (!user) {
      this.bootstrapPromise = null;
      // A token from the previous session would only mismatch the next one.
      this.csrfMemory = null;
    }
  }

  /**
   * The snapshot `maybeBootstrap` revalidates, or null when there is none.
   *
   * Validated rather than cast: storage is writable by anything on this origin,
   * so a malformed entry must read as "no snapshot" rather than as a user.
   * Only the four display fields are kept; anything resembling a token is
   * ignored by construction because it is never written here.
   */
  private readCachedUser(): UserDto | null {
    if (!this.isBrowser) {
      return null;
    }

    try {
      const raw = localStorage.getItem(CACHED_USER_KEY);

      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as Partial<UserDto> | null;

      if (
        !parsed ||
        typeof parsed.id !== 'string' ||
        typeof parsed.name !== 'string' ||
        typeof parsed.email !== 'string' ||
        (parsed.role !== 'employee' && parsed.role !== 'admin')
      ) {
        return null;
      }

      return { id: parsed.id, name: parsed.name, email: parsed.email, role: parsed.role };
    } catch {
      return null;
    }
  }

  /** Keeps the snapshot in step with the session, or removes it on sign-out. */
  private cacheUser(user: UserDto | null): void {
    if (!this.isBrowser) {
      return;
    }

    try {
      if (user) {
        localStorage.setItem(
          CACHED_USER_KEY,
          JSON.stringify({ id: user.id, name: user.name, email: user.email, role: user.role }),
        );
      } else {
        localStorage.removeItem(CACHED_USER_KEY);
      }
    } catch {
      // Best effort, like every other use of storage here: losing the snapshot
      // only costs the instant first paint, never correctness.
    }
  }

  /**
   * Records whether a session was established in this browser.
   *
   * Written the moment anybody is set and removed the moment nobody is, so a
   * reload asks the backend instead of guessing — including on a cross-site
   * deploy where the hint cookie is unreadable. Best effort, like every other
   * use of storage here: losing the flag only costs one avoided question.
   */
  private rememberSession(established: boolean): void {
    if (!this.isBrowser) {
      return;
    }

    try {
      if (established) {
        localStorage.setItem(KNOWN_SESSION_KEY, '1');
      } else {
        localStorage.removeItem(KNOWN_SESSION_KEY);
      }
    } catch {
      // Remembering is a courtesy. A browser that refuses storage still gets the
      // right answer from the server; it just always pays a request for it.
    }
  }

  /**
   * Asks for a CSRF token, keeping the echoed body value.
   *
   * Subscribed here rather than returned, because an `HttpClient` request is cold:
   * building one and not subscribing to it sends nothing at all. A failure here is
   * swallowed rather than surfaced: callers that need the value use
   * `refreshCsrfToken` and await it instead.
   */
  /**
   * Fetches a new CSRF token, for a request refused with a stale one.
   *
   * Public because the interceptor is what discovers the refusal, and it has to be
   * able to recover without the caller knowing anything went wrong.
   */
  refreshCsrfToken(): Observable<void> {
    if (!this.isBrowser) {
      return of(undefined);
    }

    // Awaitable, and that is the whole point. The caller has to use the token
    // *after* the browser has stored its cookie twin, and sending a header read
    // before that gets the value that was just refused, which fails again for
    // exactly the same reason and looks like the fix doing nothing. The body
    // carries the token, so there is no cookie to wait on.
    return this.http
      .get<CsrfResponseDto>(`${this.baseUrl}/api/auth/csrf`, this.credentials())
      .pipe(
        tap((response) => {
          this.csrfMemory = response.csrf_token;
        }),
        map(() => undefined),
        // A refresh that fails is not worth a second exception on top of the first.
        catchError(() => of(undefined)),
      );
  }

  private loadCsrfToken(): void {
    if (!this.isBrowser) {
      return;
    }

    this.http.get<CsrfResponseDto>(`${this.baseUrl}/api/auth/csrf`, this.credentials()).subscribe({
      next: (response) => {
        this.csrfMemory = response.csrf_token;
      },
      error: () => undefined,
    });
  }

  /**
   * Cookie options for every call.
   *
   * `withCredentials` is what makes a cross-origin request carry and store the
   * session cookies at all: without it the browser drops them, and sign-in appears
   * to work while leaving the app signed out on the next request.
   */
  private credentials(): { withCredentials: boolean } {
    return { withCredentials: true };
  }
}

/**
 * Whether a failed refresh means the session is over.
 *
 * Only a refusal does — 401 from the refresh route, 403 defensively. Anything
 * else (unreachable backend, timeout, 5xx) says nothing about the session, so
 * it must travel back to the caller as the transient failure it is rather
 * than being converted into a logout.
 */
function isSessionRefusal(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;

  return status === 401 || status === 403;
}
