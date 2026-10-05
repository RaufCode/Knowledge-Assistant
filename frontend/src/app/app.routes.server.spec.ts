import { RenderMode, ServerRoute } from '@angular/ssr';

import { serverRoutes } from './app.routes.server';

/** The render mode one path is served in, or undefined when no route names it. */
const modeFor = (path: string): RenderMode | undefined =>
  serverRoutes.find((route: ServerRoute) => route.path === path)?.renderMode;

describe('serverRoutes', () => {
  it('renders the signed-out screens on the server', () => {
    // These depend on nothing but what the visitor typed, so serving their markup
    // is safe and saves the round trip.
    for (const path of ['login', 'register', 'accept-invite', 'pending-approval']) {
      expect(modeFor(path)).toBe(RenderMode.Server);
    }
  });

  it('leaves the admin screens to the browser', () => {
    // The regression this protects: every admin view is a pair of branches — the
    // real screen, and an "Administrators only" refusal — and a server cannot tell
    // which is right, because it has no cookies and no storage. Rendering them there
    // shipped the refusal to administrators on every refresh, and the browser
    // replaced it a moment later.
    expect(modeFor('**')).toBe(RenderMode.Client);
  });

  it('catches every path with a single fallback, so no route escapes the browser', () => {
    // A path with no entry of its own falls through to the catch-all, which is what
    // makes this safe for routes added later. One of these for each shape the
    // app actually has: the front door, an admin screen, and a conversation.
    for (const path of ['', 'admin', 'admin/users', 'response', 'response/abc', 'not-found']) {
      expect(modeFor(path) ?? modeFor('**')).toBe(RenderMode.Client);
    }
  });
});
