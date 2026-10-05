import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuthService } from '../../core/services/auth.service';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { EmptyStateComponent } from '../../shared/components/empty-state/empty-state.component';

/**
 * Shown for an address that matches no route.
 *
 * Back goes to the assistant entry rather than the front door: `/` turns an
 * administrator away to the dashboard, so a link labelled "asking questions"
 * pointing there would land them on the overview instead of the chat. The
 * dashboard stays the primary view after sign-in; this is the way back to Ask.
 */
@Component({
  selector: 'app-not-found-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, EmptyStateComponent, RouterLink],
  host: { class: 'flex flex-1 items-center justify-center px-4 py-10' },
  template: `
    <app-empty-state
      icon="search-x"
      title="Page not found"
      message="That address does not match anything in the assistant. It may have been renamed, or the link may be incomplete."
    >
      <a app-button variant="primary" [routerLink]="auth.assistantPath()">
        Back to asking questions
      </a>
    </app-empty-state>
  `,
})
export class NotFoundViewComponent {
  /** Where the assistant is reached, which depends on the role. */
  protected readonly auth = inject(AuthService);
}
