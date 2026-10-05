import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { Message } from '../../../../core/models/message.model';
import { IconComponent } from '../../../../shared/components/icon/icon.component';

/**
 * Shown when the assistant is confident the corpus has no answer, so the user can
 * tell a genuine gap apart from a failure and knows it is worth trying again
 * differently rather than retrying the same words.
 *
 * There is no named contact or team here on purpose. The API reports only that it
 * found nothing, and naming a team to escalate to would be the frontend deciding
 * who owns the corpus. Nor is a retry offered: the same question against the same
 * corpus will find the same nothing.
 */
@Component({
  selector: 'app-answer-not-found',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div
      class="rounded-lg rounded-tl-sm border border-dashed border-border bg-muted/60
        px-5 py-4"
    >
      <div class="flex items-center gap-2 text-sm font-semibold text-foreground">
        <app-icon name="search-x" [size]="16" class="shrink-0 text-muted-foreground" />
        Not found in company documents
      </div>

      @if (explanation(); as text) {
        <p class="mt-1.5 text-sm leading-relaxed text-muted-foreground">{{ text }}</p>
      }

      <div class="mt-2.5 flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2">
        <app-icon name="info" [size]="14" class="mt-0.5 shrink-0 text-warning" />
        <span class="text-xs leading-relaxed text-foreground">
          The indexed documents do not cover this. Try rephrasing, or use the words
          the policies themselves use.
        </span>
      </div>
    </div>
  `,
})
export class AnswerNotFoundComponent {
  /** The turn that found nothing. */
  readonly message = input.required<Message>();

  /**
   * Whatever the assistant said instead of an answer, if anything. The API
   * returns an empty string for a miss, and this card should not open a blank
   * paragraph when it does.
   */
  protected readonly explanation = computed(() => {
    const text = this.message().text.trim();
    return text || '';
  });
}
