import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { LoadingIndicatorComponent } from '../../../../shared/components/loading-indicator/loading-indicator.component';

/**
 * What is shown while there is nothing to render yet: an answer being written, or a
 * saved conversation on its way back from the backend.
 *
 * A line of text and three bubbles, in the space the answer will occupy. No panel,
 * no fill, no spinner.
 *
 * **A thinking state, not a skeleton.** This began as a set of grey bars shaped like
 * the answer card, on the reasoning that a skeleton shows what is coming and holds
 * its layout. In use it did the opposite: for the best part of a minute on a cold
 * backend the bars pulse in place and read as something wedged rather than something
 * working. A placeholder that looks like the finished thing is only reassuring while
 * you believe it is about to be replaced, and nothing here can promise that.
 *
 * What replaced it says what is happening in one word and animates while it does.
 *
 * The card shell is gone, and that reverses a decision made here earlier. It was
 * argued that an answer arrives inside a card, so a card should be there first and
 * the reply should grow into a shape already on screen. But a bordered panel is a
 * claim that something has been produced, and for the whole wait nothing had been —
 * so the placeholder was the most finished-looking thing in the thread, which is the
 * opposite of what a loading state is for.
 *
 * The wording is short on purpose. A sentence about what the assistant is doing sits
 * on screen for the whole wait and becomes the thing being read instead of the
 * answer, and a longer explanation of a two-second wait is worse than nothing.
 */
@Component({
  selector: 'app-answer-pending',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LoadingIndicatorComponent],
  host: { class: 'block' },
  template: `
    <!--
      No card.

      There was one, and it was the wrong shape twice over: a bordered panel implying
      a finished answer that was not coming yet, and a tinted fill that made the
      placeholder more colourful than the answer it was standing in for. What replaces
      it is the same mark the answer will end with, in the space the answer will
      occupy, and nothing else.
    -->
    <div class="flex items-center py-1" role="status">
      <app-loading-indicator [label]="label()" />

      <!--
        Read once by assistive tech and then left alone. A live region announces every
        change, so a label that varied would be read over and over; this one is static
        for exactly that reason.
      -->
      <span class="sr-only">{{ announcement() }}</span>
    </div>
  `,
})
export class AnswerPendingComponent {
  /**
   * The short label beside the indicator.
   *
   * Defaults to the case this card is mostly for. The caller overrides it where
   * something else is being waited on, because "Thinking" while a saved conversation
   * is being fetched would claim work that is not happening.
   */
  readonly label = input('Thinking');

  /** The fuller sentence for assistive tech, which is not read aloud repeatedly. */
  readonly announcement = input('The assistant is thinking.');
}