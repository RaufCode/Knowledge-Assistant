import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { Message } from '../../../../core/models/message.model';
import { IconComponent } from '../../../../shared/components/icon/icon.component';

/**
 * Shown when a question was turned away before any document was read.
 *
 * Separate from the not-found card, and the distinction is the whole point of this
 * component. "Not found in company documents" says the corpus has a gap; this says
 * the question was not answered on purpose. Drawing a refusal as a failed search
 * would tell somebody the answer was merely missing when in fact it was withheld,
 * and would send them off to rephrase a question that will be turned away however
 * it is phrased.
 *
 * The notice names HR as the route, because the backend says confidential
 * information is HR's to give. It names no individual and no record: a refusal that
 * said "Ama's salary is confidential" would confirm the file exists.
 */
@Component({
  selector: 'app-answer-restricted',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div
      class="rounded-lg rounded-tl-sm border border-warning/30 bg-warning-bg px-5 py-4"
    >
      <div class="flex items-center gap-2 text-sm font-semibold text-foreground">
        <app-icon name="lock" [size]="16" class="shrink-0 text-warning" />
        Not shared
      </div>

      <p class="mt-1.5 text-sm leading-relaxed text-muted-foreground">{{ message().text }}</p>

      <div class="mt-2.5 flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2">
        <app-icon name="info" [size]="14" class="mt-0.5 shrink-0 text-warning" />
        <span class="text-xs leading-relaxed text-foreground">
          Restricted information is not shared through this assistant, whoever asks.
          Rephrasing the question will not change that.
        </span>
      </div>
    </div>
  `,
})
export class AnswerRestrictedComponent {
  /** The turn that was turned away. */
  readonly message = input.required<Message>();
}