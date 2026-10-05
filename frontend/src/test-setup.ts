import { beforeEach } from 'vitest';

/**
 * Wipes browser storage between tests.
 *
 * `localStorage` and `sessionStorage` outlive the TestBed, so anything the app
 * persists for the next page load — the remembered session, the cached user, the
 * remembered email — survives into the following test and is read as though that
 * test had signed in. Several specs already clear storage by hand, but only the
 * keys they happened to know about, and a component that legitimately reads a
 * cached user then greets a name a previous test invented.
 *
 * Done here rather than per spec so the isolation is a property of the suite
 * instead of a rule every new spec has to remember. Cookies are deliberately left
 * alone: they are set explicitly per test, and clearing them by name would mean
 * maintaining a second list of names in a third place.
 */
beforeEach(() => {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // A browser that refuses storage is exactly the case `AuthService` is written
    // to survive, so a test environment doing it must not be the thing that fails.
  }
});
