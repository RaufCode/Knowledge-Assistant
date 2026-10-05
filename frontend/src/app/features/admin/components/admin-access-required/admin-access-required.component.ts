import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { Router } from '@angular/router';

import { ButtonComponent } from '../../../../shared/components/button/button.component';
import { EmptyStateComponent } from '../../../../shared/components/empty-state/empty-state.component';

/**
 * Stands in for a real route guard. An administrator-only screen reached by an
 * employee explains itself rather than quietly doing nothing.
 */
@Component({
  selector: 'app-admin-access-required',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, EmptyStateComponent],
  host: { class: 'flex flex-1 items-center justify-center px-4 py-10' },
  template: `
    <app-empty-state icon="lock" tone="danger" title="Administrators only" [message]="message()">
      <button app-button type="button" variant="outline" (click)="goBack()">
        Back to asking questions
      </button>
    </app-empty-state>
  `,
})
export class AdminAccessRequiredComponent {
  /** Explains why the area is closed to this viewer. */
  readonly message = input(
    'Your account does not have administrator access, so this area is not available. Ask an administrator if you think that is wrong.',
  );

  private readonly router = inject(Router);

  /** Returns to the dashboard. */
  protected goBack(): void {
    void this.router.navigate(['/']);
  }
}
