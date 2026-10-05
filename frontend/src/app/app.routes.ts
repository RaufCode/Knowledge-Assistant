import { Routes } from '@angular/router';

import { adminGuard, authGuard, guestGuard, landingGuard } from './core/guards/auth.guard';

/**
 * Each view is lazily loaded, so the initial bundle only carries the shell.
 * The response view still reads `:id` itself rather than taking a bound input,
 * so it stays in charge of what an unknown id means.
 *
 * `response/:id` addresses one conversation by its own id, which never changes,
 * so the link keeps working however long afterwards it is followed. The bare
 * `response` route follows the conversation that was last active, which is where
 * a question sent from the dashboard lands.
 *
 * The signed-out screens come first and are the only routes that render without the
 * sidebar. They are marked `data: { plain: true }` rather than being listed in the
 * shell, so that "this screen has no sidebar" is said where the screen is declared
 * rather than in a second list somewhere else that has to be kept in step.
 *
 * `authGuard` covers every route that shows company knowledge, and `adminGuard`
 * covers the three administration screens on top of it. The guards are a
 * convenience, not the boundary: the server refuses an unauthenticated request to
 * the same routes with a 401, and an employee asking for an admin one with a 403,
 * so a guard that was bypassed entirely would still not get anybody through.
 */
export const routes: Routes = [
  {
    path: 'login',
    pathMatch: 'full',
    title: 'Sign in · Internal Knowledge Assistant',
    canActivate: [guestGuard],
    data: { plain: true },
    loadComponent: () =>
      import('./features/auth/views/login-view/login-view.component').then(
        (module) => module.LoginViewComponent,
      ),
  },
  {
    // Not registration, despite the path: this asks an administrator for an account
    // rather than creating one. No user row exists until somebody approves, and the
    // role is set by them. The path is kept because it is the one people type.
    path: 'register',
    pathMatch: 'full',
    title: 'Request access · Internal Knowledge Assistant',
    canActivate: [guestGuard],
    data: { plain: true },
    loadComponent: () =>
      import('./features/auth/views/register-view/register-view.component').then(
        (module) => module.RegisterViewComponent,
      ),
  },
  {
    path: 'accept-invite',
    pathMatch: 'full',
    title: 'Set your password · Internal Knowledge Assistant',
    canActivate: [guestGuard],
    data: { plain: true },
    loadComponent: () =>
      import('./features/auth/views/accept-invite-view/accept-invite-view.component').then(
        (module) => module.AcceptInviteViewComponent,
      ),
  },
  {
    // Where a correct sign-in for an unapproved account lands. Not behind
    // `authGuard`: the account is switched off, so there is no session and the guard
    // would bounce the person straight back to sign in with nothing said.
    path: 'pending-approval',
    pathMatch: 'full',
    title: 'Waiting for approval · Internal Knowledge Assistant',
    data: { plain: true },
    loadComponent: () =>
      import('./features/auth/views/pending-approval-view/pending-approval-view.component').then(
        (module) => module.PendingApprovalViewComponent,
      ),
  },
  {
    path: '',
    pathMatch: 'full',
    title: 'Internal Knowledge Assistant',
    // `landingGuard` sends an administrator to the dashboard. The root is the app's
    // front door rather than the only way to the assistant: `/ask` below is that,
    // which is what lets the sidebar's "Ask" link keep working for an administrator
    // instead of bouncing them straight back here.
    canActivate: [authGuard, landingGuard],
    loadComponent: () =>
      import('./views/dashboard-view/dashboard-view.component').then(
        (module) => module.DashboardViewComponent,
      ),
  },
  {
    // The assistant, deliberately reached. A real route rather than a redirect onto
    // the root, because the root now turns administrators away and this is where
    // they are sent when they choose to ask something instead.
    path: 'ask',
    pathMatch: 'full',
    title: 'Ask a question · Internal Knowledge Assistant',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./views/dashboard-view/dashboard-view.component').then(
        (module) => module.DashboardViewComponent,
      ),
  },
  {
    path: 'response',
    title: 'Answer · Internal Knowledge Assistant',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./views/response-view/response-view.component').then(
        (module) => module.ResponseViewComponent,
      ),
  },
  {
    path: 'response/:id',
    title: 'Answer · Internal Knowledge Assistant',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./views/response-view/response-view.component').then(
        (module) => module.ResponseViewComponent,
      ),
  },
  {
    path: 'conversations',
    title: 'Conversations · Internal Knowledge Assistant',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./views/conversations-view/conversations-view.component').then(
        (module) => module.ConversationsViewComponent,
      ),
  },
  {
    path: 'admin',
    pathMatch: 'full',
    title: 'Administration · Internal Knowledge Assistant',
    canActivate: [authGuard, adminGuard],
    loadComponent: () =>
      import('./views/admin-dashboard-view/admin-dashboard-view.component').then(
        (module) => module.AdminDashboardViewComponent,
      ),
  },
  {
    path: 'admin/documents',
    title: 'Documents · Internal Knowledge Assistant',
    canActivate: [authGuard, adminGuard],
    loadComponent: () =>
      import('./views/admin-documents-view/admin-documents-view.component').then(
        (module) => module.AdminDocumentsViewComponent,
      ),
  },
  {
    path: 'admin/questions',
    title: 'Question logs · Internal Knowledge Assistant',
    canActivate: [authGuard, adminGuard],
    loadComponent: () =>
      import('./views/admin-question-logs-view/admin-question-logs-view.component').then(
        (module) => module.AdminQuestionLogsViewComponent,
      ),
  },
  {
    path: 'admin/users',
    title: 'Users · Internal Knowledge Assistant',
    canActivate: [authGuard, adminGuard],
    loadComponent: () =>
      import('./views/admin-users-view/admin-users-view.component').then(
        (module) => module.AdminUsersViewComponent,
      ),
  },
  {
    // The old address, kept working rather than 404ing: it is in bookmarks and in
    // anything somebody was sent before the screen was renamed.
    path: 'admin/invite',
    redirectTo: 'admin/users',
  },
  {
    path: 'admin/access',
    title: 'Access requests · Internal Knowledge Assistant',
    canActivate: [authGuard, adminGuard],
    loadComponent: () =>
      import('./views/admin-access-requests-view/admin-access-requests-view.component').then(
        (module) => module.AdminAccessRequestsViewComponent,
      ),
  },
  {
    path: 'not-found',
    title: 'Page not found · Internal Knowledge Assistant',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./views/not-found-view/not-found-view.component').then(
        (module) => module.NotFoundViewComponent,
      ),
  },
  {
    path: '**',
    redirectTo: 'not-found',
  },
];
