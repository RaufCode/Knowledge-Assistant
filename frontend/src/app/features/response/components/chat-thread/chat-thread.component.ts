import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { Message } from '../../../../core/models/message.model';
import { AnswerCardComponent } from '../answer-card/answer-card.component';
import { AnswerFailedComponent } from '../answer-failed/answer-failed.component';
import { AnswerNotFoundComponent } from '../answer-not-found/answer-not-found.component';
import { AnswerOutOfScopeComponent } from '../answer-out-of-scope/answer-out-of-scope.component';
import { AnswerPendingComponent } from '../answer-pending/answer-pending.component';
import { AnswerRestrictedComponent } from '../answer-restricted/answer-restricted.component';
import { MessageBubbleComponent } from '../message-bubble/message-bubble.component';

/**
 * How far from the bottom still counts as "at the bottom", in pixels.
 *
 * Not zero because a stream grows the content between one scroll and the next:
 * rounding a fraction of a pixel down leaves a hairline gap that reads as the user
 * having scrolled away and silently stops the thread following the answer.
 */
const AT_BOTTOM_SLACK_PX = 24;

/**
 * The conversation itself: user bubbles on the right, assistant turns on the
 * left with the right card per state (answer, no match, still searching).
 *
 * This is the only scrollable container in the view. The header and the composer
 * sit outside it in a fixed-height column, so reading back through a long
 * conversation moves the messages and nothing else.
 *
 * It also follows the newest content as it arrives, and stops as soon as the user
 * scrolls up to read something earlier: yanking them back to the bottom while
 * they are reading is worse than letting the newest lines arrive off screen.
 */
@Component({
  selector: 'app-chat-thread',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AnswerCardComponent,
    AnswerFailedComponent,
    AnswerNotFoundComponent,
    AnswerOutOfScopeComponent,
    AnswerPendingComponent,
    AnswerRestrictedComponent,
    MessageBubbleComponent,
  ],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <div
      #scroller
      class="scrollbar-thin min-h-0 flex-1 overflow-y-auto"
      role="log"
      aria-live="polite"
      aria-label="Conversation"
      (scroll)="onScroll()"
    >
      <!-- The padding keeps the last message clear of the composer rather than
           flush against it, which is what makes a finished answer look cut off. -->
      <div class="mx-auto flex w-full max-w-thread flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        @for (message of messages(); track message.id; let index = $index) {
          @if (message.role === 'user') {
            <app-message-bubble
              [message]="message"
              [canEdit]="canEdit() && !isAnswered(index)"
              (edited)="onEdited($event)"
            />
          } @else {
            <div class="min-w-0 flex-1">
              @switch (message.status) {
                @case ('pending') {
                  <!-- Text on a pending turn means the answer is streaming in.
                       Before the first piece arrives the card says it is
                       thinking, which is all there is to say. The caption that used
                       to sit underneath spelled out what was happening and became
                       the thing being read for the whole wait. -->
                  @if (message.text) {
                    <app-answer-card [message]="message" [isStreaming]="true" />
                  } @else {
                    <app-answer-pending />
                  }
                }
                @case ('not-found') {
                  <app-answer-not-found [message]="message" />
                }
                @case ('out-of-scope') {
                  <!-- Also not a failed search, and kept apart from the not-found
                       card for a sharper reason: that one says the documents do
                       not cover an in-scope question, this one says the question
                       was never in scope. Drawing them alike would send somebody
                       to HR over a general-knowledge question. -->
                  <app-answer-out-of-scope [message]="message" />
                }
                @case ('restricted') {
                  <!-- A refusal, not a failed search: the card says so rather than
                       claiming the documents do not cover the question. A greeting
                       needs no card of its own and falls through to the answer one,
                       because that is exactly what it is — an answer, just not one
                       drawn from a document. -->
                  <app-answer-restricted [message]="message" />
                }
                @case ('failed') {
                  <app-answer-failed
                    [message]="message"
                    [isBusy]="isBusy()"
                    (retry)="retry.emit($event)"
                  />
                }
                @default {
                  <app-answer-card [message]="message" />
                }
              }
            </div>
          }
        }
      </div>
    </div>
  `,
})
export class ChatThreadComponent {
  /** Turns to render, oldest first. */
  readonly messages = input.required<Message[]>();

  /** Disables retry while a request is in flight. */
  readonly isBusy = input(false);

  /**
   * Whether a question may be corrected right now.
   *
   * False while an answer is being written: a correction asks the question again, and
   * two requests against one conversation would race for which answer belongs to
   * which wording.
   */
  readonly canEdit = input(true);

  /** Emits the id of a turn whose question should be asked again. */
  readonly retry = output<string>();

  /**
   * Emits a corrected question: the id that was edited and the words replacing it.
   *
   * Carries both rather than having the thread guess which message an edit belongs
   * to. The bubble knows the text and nothing else, and a thread that inferred the
   * target from its own state would be guessing.
   */
  readonly edited = output<{ id: string; content: string }>();

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  /**
   * False once the reader has scrolled up, and the thread stops pulling them down
   * until they come back to the bottom themselves.
   */
  private readonly isFollowingState = signal(true);

  /**
   * What the reader can see, as one string: how many messages there are and how
   * much text each holds.
   *
   * The scroll effect watches this rather than the message count. A streaming
   * answer grows inside the message it belongs to, so a count never changes while
   * the answer is written out and the thread would sit still for the whole of it.
   */
  private readonly contentSignature = computed(() =>
    this.messages()
      .map((message) => `${message.id}:${message.text.length}`)
      .join('|'),
  );

  /** Message count as of the last render, to spot a new turn arriving. */
  private renderedCount = 0;

  constructor() {
    // Keep the newest content visible as the conversation grows and as an answer
    // streams in. Runs after render so the new content is already laid out, and
    // only while the reader is at the bottom.
    afterRenderEffect(() => {
      this.contentSignature();

      const element = this.scroller()?.nativeElement;

      if (!element) {
        return;
      }

      const count = this.messages().length;

      // A new message is the user asking something or following a link to a longer
      // part of the thread. Either way they want to see the end of it, so this
      // resumes following even after they had scrolled up.
      if (count > this.renderedCount) {
        this.isFollowingState.set(true);
      }

      this.renderedCount = count;

      if (this.isFollowingState()) {
        element.scrollTop = element.scrollHeight;
      }
    });
  }

  /** Passes a correction up with the message it belongs to. */
  /**
   * Whether this turn has already been answered.
   *
   * Editing stops once the answer has arrived. The edit rewrites the question and
   * sends it again as a new turn, so on an answered question it was offering to
   * contradict what the assistant had already said — and the old answer stayed on
   * screen underneath, leaving the thread reading as though the new question had
   * been asked before it was.
   *
   * Judged from what follows rather than from a flag on the message: a turn is
   * answered when there is an answer after it, which is the same thing said in a way
   * that cannot drift out of step with the thread it is part of.
   */
  protected isAnswered(index: number): boolean {
    return this.messages().slice(index + 1).some((message) => message.role === 'assistant');
  }

  protected onEdited(edit: { id: string; content: string }): void {
    this.edited.emit(edit);
  }

  /**
   * Records whether the reader is at the bottom, which is what decides whether the
   * thread keeps scrolling itself.
   */
  protected onScroll(): void {
    const element = this.scroller()?.nativeElement;

    if (!element) {
      return;
    }

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;

    this.isFollowingState.set(distanceFromBottom <= AT_BOTTOM_SLACK_PX);
  }
}
