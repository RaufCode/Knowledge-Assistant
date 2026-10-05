import { RenderMode, ServerRoute } from '@angular/ssr';

/**
 * Rendered on demand rather than prerendered.
 *
 * The response route is parameterised (`/response/:id`) and every screen is
 * backed by a session the server does not share with the browser, so a prerender
 * pass would have nothing real to cache. A server render also never calls the
 * backend: the conversation belongs to the browser's session, and fetching it
 * here would pay the round trip on every request to paint a shell the client is
 * about to fill anyway.
 */
export const serverRoutes: ServerRoute[] = [
  {
    path: '**',
    renderMode: RenderMode.Server,
  },
];
