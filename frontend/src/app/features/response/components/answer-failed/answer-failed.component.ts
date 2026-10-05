import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { Message } from '../../../../core/models/message.model';
import { ButtonComponent } from '../../../../shared/components/button/button.component';
import { IconComponent } from '../../../../shared/components/icon/icon.component';

/**
 * Shown when the request for a message failed, rather than when the assistant
 * answered that it had nothing.
 *
 * The distinction is the whole point of the card. "Not found in company
 * documents" is a confident statement about the corpus and there is nothing to
 * retry; a failed request means the answer may well exist, so the card offers to
 * ask again instead of sending the user off to rephrase.
 */@Component({
  selector: 'app-answer-failed',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div
      class="rounded-lg rounded-tl-sm border border-danger/30 bg-danger-bg px-5 py-4"
      role="alert"
    >
      <div class="flex items-center gap-2 text-sm font-semibold text-foreground">
        <app-icon name="info" [size]="16" class="shrink-0 text-danger" />
        The assistant could not answer
      </div>
      <p class="mt-1.5 text-sm leading-relaxed text-muted-foreground">{{ message().text }}</p>

        <button
          app-button
          type="button"
          variant="outline"
          size="sm"
          class="mt-3"
          [disabled]="isBusy()"
          (click)="retry.emit(message().id)"
        >
          Try again
        </button>
    </div>
  `,
})
export class AnswerFailedComponent {
  /** The turn whose request failed. */
  readonly message = input.required<Message>();

  /** Disables the retry control while the same question is already in flight. */
  readonly isBusy = input(false);

  /**
   * Emits the message to ask again. The id is the failed answer's own, so the
   * card does not have to know that a question and its answer are a pair: the
   * thread finds the question it belongs to.
   */
  readonly retry = output<string>();
}
