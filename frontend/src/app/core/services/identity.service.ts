import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';

import { CLIENT_ID_STORAGE_KEY } from '../api.config';

/**
 * Who this browser is, for the backend's purposes.
 *
 * Conversations are owned by a client id rather than a login, so one browser
 * with one id would hand every account signed in on it the same threads: an
 * employee signing in after an administrator would open the administrator's
 * conversations. The id is therefore kept **per account** — the signed-in
 * account's own id while signed in, and the anonymous one otherwise — so a
 * thread is only ever listed, read or deleted beside the account that made it.
 *
 * Each id is generated once and kept in `localStorage`, so an account keeps its
 * own conversations across reloads and tabs. An id is not a credential, and the
 * backend uses it only to answer "are these conversations yours".
 */
@Injectable({ providedIn: 'root' })
export class IdentityService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly clientIdState = signal<string>(this.read(CLIENT_ID_STORAGE_KEY));

  /** The id this browser's conversations belong to, for the current account. */
  readonly clientId = this.clientIdState.asReadonly();

  /**
   * Points this browser at an account's own id, or back at the anonymous one.
   *
   * Called whenever the signed-in account changes, so threads never cross from
   * one account to another on a shared browser. Switching back to an account
   * restores the id it had before, so its threads come back with it.
   */
  bindToAccount(userId: string | null): void {
    if (!this.isBrowser) {
      return;
    }

    this.clientIdState.set(
      this.read(userId === null ? CLIENT_ID_STORAGE_KEY : `${CLIENT_ID_STORAGE_KEY}.${userId}`),
    );
  }

  /**
   * The existing id under this key, or a new one the first time it is asked for.
   *
   * Generated lazily rather than in the constructor so a server render does not
   * mint an id per request: a different id on every request would put a server
   * render's conversations somewhere no client can ever find them.
   */
  private read(key: string): string {
    if (!this.isBrowser) {
      return '';
    }

    try {
      const stored = localStorage.getItem(key);

      if (stored) {
        return stored;
      }
    } catch {
      // Storage can be unavailable in private modes. The id is then held in memory
      // for this page's lifetime, which costs the user their conversations on the
      // next reload and is not worth an error on screen.
    }

    const created = newClientId();
    this.persist(key, created);

    return created;
  }

  private persist(key: string, clientId: string): void {
    try {
      localStorage.setItem(key, clientId);
    } catch {
      // As above: the id works for this page either way.
    }
  }
}

/**
 * A fresh client id.
 *
 * `crypto.randomUUID` where it exists, and a v4-shaped random hex string where it
 * does not: older browsers and non-secure origins lack it, and a client that cannot
 * name itself at all would see an empty list forever. The backend only checks the
 * length, so the shape matters more than the source of the randomness.
 */
function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (digit) => {
    const random = Math.floor(Math.random() * 16);
    const value = digit === 'x' ? random : (random & 0x3) | 0x8;

    return value.toString(16);
  });
}
