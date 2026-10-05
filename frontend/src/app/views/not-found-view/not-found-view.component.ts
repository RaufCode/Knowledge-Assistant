import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ButtonComponent } from '../../shared/components/button/button.component';
import { EmptyStateComponent } from '../../shared/components/empty-state/empty-state.component';

/** Shown for an address that matches no route. */
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
      <a app-button variant="primary" routerLink="/">Back to asking questions</a>
    </app-empty-state>
  `,
})
export class NotFoundViewComponent {}
