import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';

import { CLIENT_ID_STORAGE_KEY } from '../api.config';

/**
 * Who this browser is, for the backend's purposes.
 *
 * Conversations are owned by a client id rather than a login, and this is the one
 * place that id comes from. It is generated once and kept in `localStorage`, so the
 * same browser keeps the same conversations across reloads and across tabs, and
 * every request that names a conversation carries it.
 *
 * It is an anonymous id and nothing more: it is not a credential, and the backend
 * uses it only to answer "are these conversations yours". Anyone who learns it can
 * list, read and delete that client's conversations, which is why it is stored
 * under a namespaced key and never sent anywhere the app does not already talk to.
 */
@Injectable({ providedIn: 'root' })
export class IdentityService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly clientIdState = signal<string>(this.read());

  /** The id this browser's conversations belong to. */
  readonly clientId = this.clientIdState.asReadonly();

  /**
   * The existing id, or a new one the first time this browser asks.
   *
   * Generated lazily rather than in the constructor so a server render does not
   * mint an id per request: a different id on every request would put a server
   * render's conversations somewhere no client can ever find them.
   */
  private read(): string {
    if (!this.isBrowser) {
      return '';
    }

    try {
      const stored = localStorage.getItem(CLIENT_ID_STORAGE_KEY);

      if (stored) {
        return stored;
      }
    } catch {
      // Storage can be unavailable in private modes. The id is then held in memory
      // for this page's lifetime, which costs the user their conversations on the
      // next reload and is not worth an error on screen.
    }

    const created = newClientId();
    this.persist(created);

    return created;
  }

  private persist(clientId: string): void {
    try {
      localStorage.setItem(CLIENT_ID_STORAGE_KEY, clientId);
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
