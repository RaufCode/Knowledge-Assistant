import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { Message } from '../../../../core/models/message.model';
import { IconComponent } from '../../../../shared/components/icon/icon.component';

/**
 * Shown when the question was never something this assistant answers.
 *
 * A separate card from the not-found one, and the distinction is the whole point.
 * "Not found in company documents" is a claim about the corpus — that the answer
 * exists somewhere and this set does not have it — and it names HR as the route to
 * it. For a general-knowledge question both are wrong: there is no policy about it
 * to go and ask HR for, and saying so reads as though the assistant had
 * misunderstood rather than as one that knows what it is for.
 *
 * No named contact here, for the same reason the not-found card names none in its
 * own wording: what the assistant is for is a fact about the assistant, and naming
 * a team to escalate to would be the frontend deciding who owns that.
 */
@Component({
  selector: 'app-answer-out-of-scope',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div
      class="rounded-lg rounded-tl-sm border border-border bg-muted/60
        px-5 py-4"
    >
      <div class="flex items-center gap-2 text-sm font-semibold text-foreground">
        <app-icon name="compass" [size]="16" class="shrink-0 text-muted-foreground" />
        Outside what I cover
      </div>

      <p class="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        {{ message().text }}
      </p>

      <div class="mt-2.5 flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2">
        <app-icon name="info" [size]="14" class="mt-0.5 shrink-0 text-muted-foreground" />
        <span class="text-xs leading-relaxed text-foreground">
          That is not a gap in the documents. Ask about a policy, a process or an
          internal procedure and I will look it up.
        </span>
      </div>
    </div>
  `,
})
export class AnswerOutOfScopeComponent {
  /** The turn that was out of scope. */
  readonly message = input.required<Message>();
}
