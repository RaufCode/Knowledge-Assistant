import { Provider, computed, signal } from '@angular/core';
import { Observable, of } from 'rxjs';

import type { AccessRequestListDto, AccessRequestRowDto } from '../models/access-request.model';
import type { Role, UserDto } from '../models/auth.model';
import { AuthService } from '../services/auth.service';

/**
 * Registers the stub as the app's `AuthService`.
 *
 * Returned rather than written inline in each spec so that the token and the class
 * are always wired together: a spec that provides the class without the token would
 * silently test the real service, which would then try to reach a backend.
 */
export function provideAuthStub(): Provider[] {
  return [AuthServiceStub, { provide: AuthService, useExisting: AuthServiceStub }];
}

/**
 * A stand-in for `AuthService` whose answers the test decides.
 *
 * The role now comes from the backend rather than from a switch in the app, so a
 * component test cannot flip it by calling a method on the real service. It sets the
 * signals this stub exposes instead, which is the same seam `GET /api/auth/me` goes
 * through: the components under test are reading the session, and how the session
 * arrived is not their business.
 */
export class AuthServiceStub {
  private readonly userState = signal<UserDto | null>(null);

  /** The signed-in person, or null. */
  readonly user = this.userState.asReadonly();

  readonly status = signal<'unknown' | 'authenticated' | 'anonymous'>('authenticated');

  readonly isAuthenticated = signal(true);

  private readonly adminState = signal(false);

  /** The access-request queue, settable so a test can put something in it. */
  private readonly accessRequestsState = signal<AccessRequestRowDto[]>([]);

  /** Whether the signed-in person may reach the admin routes. */
  readonly isAdmin = this.adminState.asReadonly();

  /**
   * Whether somebody is signed in who is not an administrator.
   *
   * Mirrors the real service's rule, so a spec that signs somebody out sees the same
   * thing the screens see: no user is not a user without administrator access, and
   * the two must not be answered the same way.
   */
  readonly lacksAdminAccess = computed(() => this.isAuthenticated() && !this.isAdmin());

  /**
   * Where this person lands after signing in.
   *
   * Mirrors the real service's rule rather than being a fixed value, because the
   * screens that navigate on sign-in read it and a stub answering `/` for an
   * administrator would hide the behaviour under test.
   */
  readonly landingPath = computed(() => (this.isAdmin() ? '/admin' : '/'));

  /**
   * Where the assistant is reached deliberately.
   *
   * Mirrors the real service's rule for the same reason `landingPath` does: the
   * sidebar links here, and a stub answering `/` for an administrator would point
   * the link at the front door that turns administrators away.
   */
  readonly assistantPath = computed(() => (this.isAdmin() ? '/ask' : '/'));

  /** Sign-out is a navigation in these tests, so the call itself does nothing. */
  logout(): Observable<void> {
    this.setRole('anonymous');

    return of(undefined);
  }

  /**
   * Changes the signed-in person's own password.
   *
   * Always succeeds: there is no backend to check the current password against
   * here. Present so the account card's dialog calls the same seam as the real
   * service rather than one the tests cannot reach.
   */
  changeOwnPassword(): Observable<void> {
    return of(undefined);
  }

  /**
   * A token, so streams need no refresh round trip first.
   *
   * The spec asserts on what the stream sent straight after `ask`, and a stub
   * without a token would defer the request behind a token fetch, which is
   * transport detail this stub has no reason to simulate.
   */
  readCsrfToken(): string {
    return 'stub-csrf-token';
  }

  /**
   * Nothing to refresh.
   *
   * Present so the stream's recovery path has something to call; the tests
   * that care about a real token and a real cookie use the real service.
   */
  refreshCsrfToken(): Observable<void> {
    return of(undefined);
  }

  /**
   * Whether this is a browser, which is true in every component test.
   *
   * Overridden only so a test that wants to see the server-render behaviour can say
   * so; nothing here runs on a server.
   */
  isBrowserOnly(): boolean {
    return true;
  }

  /**
   * The access-request queue, as `GET /api/auth/requests` would answer it.
   *
   * Settable through `setAccessRequests` rather than fixed empty, because the
   * dashboard counts the pending ones and a stub that always said "none" would let a
   * broken count pass. Reading the queue is transport, and `AuthService`'s own spec
   * covers that; this only has to be able to say what it found.
   */
  listAccessRequests(): Observable<AccessRequestListDto> {
    return of({ requests: this.accessRequestsState() });
  }

  /** Puts a queue in place, as the backend would have answered. */
  setAccessRequests(requests: AccessRequestRowDto[]): void {
    this.accessRequestsState.set(requests);
  }

  /** Always succeeds, because there is no backend to fail against here. */
  refresh(): Promise<UserDto | null> {
    return Promise.resolve(this.user());
  }

  /** Puts a person in a role, the way `GET /api/auth/me` would. */
  /**
   * Ends the local session, as the real service does.
   *
   * Present because the sidebar signs out through it before it routes: a stub
   * without it threw before anything navigated, and the person "signed out" into a
   * route they never left.
   */
  clear(): void {
    this.setRole('anonymous');
  }

  setRole(role: Role | 'anonymous', name = 'Ama Konadu'): void {
    if (role === 'anonymous') {
      this.userState.set(null);
      this.adminState.set(false);
      this.isAuthenticated.set(false);
      this.status.set('anonymous');

      return;
    }

    this.userState.set({
      id: 'test-user',
      name,
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@acmetech.example`,
      role,
    });
    this.adminState.set(role === 'admin');
    this.isAuthenticated.set(true);
    this.status.set('authenticated');
  }
}

/** The providers a test needs to put the stub in place. */
export function authStubProviders(): Provider[] {
  return [provideAuthStub()];
}
