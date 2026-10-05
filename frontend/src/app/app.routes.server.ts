import { RenderMode, ServerRoute } from '@angular/ssr';

/**
 * The signed-out screens, which the server renders.
 *
 * Nothing here depends on who is signed in — a form, a waiting message, a
 * pre-filled invitation — so the markup the server produces is the markup the
 * browser would have produced, and rendering it saves a round trip.
 */
const SIGNED_OUT_ROUTES: ServerRoute[] = [
  { path: 'login', renderMode: RenderMode.Server },
  { path: 'register', renderMode: RenderMode.Server },
  { path: 'accept-invite', renderMode: RenderMode.Server },
  { path: 'pending-approval', renderMode: RenderMode.Server },
];

/**
 * Everything else is rendered by the browser, and this is the fix for an
 * administrator seeing "Administrators only" on every refresh of an admin page.
 *
 * Each admin screen is a pair of branches — the real one, and a refusal for
 * anybody who is not an administrator. Which branch is correct depends on the
 * signed-in person's role, and a server render has no way to know it: no cookies
 * reach it and `localStorage` does not exist there. So it answered "not an
 * administrator" for everybody and shipped the refusal inside the HTML, and the
 * browser then replaced it with the real screen a moment later. That flash is
 * what was being reported.
 *
 * A refusal screen is the wrong thing to guess at, and deleting it would leave an
 * employee on an admin route with an empty page instead of an explanation. Not
 * rendering role-dependent markup at all is the part that is actually correct:
 * the browser knows the role, so the browser draws it, and the first paint of an
 * admin page is that page.
 *
 * The response route is parameterised (`/response/:id`) and every one of these is
 * backed by a session the server does not share with the browser, so a prerender
 * pass would have had nothing real to cache either way.
 */
export const serverRoutes: ServerRoute[] = [
  ...SIGNED_OUT_ROUTES,
  {
    path: '**',
    renderMode: RenderMode.Client,
  },
];
