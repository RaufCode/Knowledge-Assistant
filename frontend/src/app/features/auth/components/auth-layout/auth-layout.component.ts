import { ChangeDetectionStrategy, Component } from '@angular/core';

import { BrandLogoComponent } from '../../../chat/components/brand-logo/brand-logo.component';

/**
 * The frame every signed-out screen sits in: the product name and a single card.
 *
 * Nothing else. Two notes used to sit underneath and both are gone:
 *
 * - One said this was a design preview and that nothing entered was sent anywhere.
 *   True while the screens collected input and threw it away, false the moment the
 *   sign-in form was wired to the backend, and a password typed into a form claiming
 *   to send nothing is worse than no note at all.
 * - The next said accounts are created by invitation and that the session lives in a
 *   secure cookie. Both true, and neither the reader's problem at the moment they are
 *   trying to sign in. It also named a company that is not the one this product is
 *   for.
 *
 * What is left is the product name, set as prominently as a name that is the whole
 * identity on the screen can be.
 */
@Component({
  selector: 'app-auth-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BrandLogoComponent],
  host: {
    class:
      'flex flex-1 flex-col items-center justify-center overflow-y-auto bg-background px-4 py-10',
  },
  template: `
    <div class="flex w-full max-w-md flex-col gap-8">
      <app-brand-logo
        tone="light"
        [showMark]="false"
        [centered]="true"
        [prominent]="true"
        class="self-center"
      />

      <div class="rounded-lg border border-border bg-card p-6 shadow-card sm:p-8">
        <ng-content />
      </div>
    </div>
  `,
})
export class AuthLayoutComponent {}
