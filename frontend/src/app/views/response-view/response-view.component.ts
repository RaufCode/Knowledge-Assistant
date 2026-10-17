import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';

import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';
import { QuestionInputComponent } from '../../features/ask/components/question-input/question-input.component';
import { ViewHeaderComponent } from '../../features/chat/components/view-header/view-header.component';
import { ChatThreadComponent } from '../../features/response/components/chat-thread/chat-thread.component';
import { AnswerPendingComponent } from '../../features/response/components/answer-pending/answer-pending.component';

/**
 * Shows one conversation: its whole thread and the composer for follow-up
 * questions. A view only assembles components and connects them to services.
 *
 * The route's `:id` is the conversation's own id, and a conversation's id never
 * changes, so a link to one keeps working however long afterwards it is followed.
 * It is optional: `/response` with no id follows the conversation that was last
 * active, which is where a question sent from the dashboard lands.
 *
 * An id that is not there — deleted, or another account's — is not a page of its
 * own. The conversation closes and this route sends the reader to the assistant's
 * entry, which is a window with no conversation in it: the same state as opening
 * the app, and the only state in which nothing in the sidebar is lit up.
 */
@Component({
  selector: 'app-response-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AnswerPendingComponent,
    ChatThreadComponent,
    QuestionInputComponent,
    ViewHeaderComponent,
  ],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <!-- Fixed above the scrollable area: reading back through a long conversation
         moves the messages under it and never takes the title with them. -->
    <app-view-header [title]="chat.threadTitle()" />

    @if (chat.isResolving()) {
      <!--
        A conversation is on its way. A line that says what is happening, not a
        skeleton: this is a stored thread being read back, and nothing here is
        being thought up or worked out, so the phony shape of an answer would
        pulse at a wait it was not part of. The card says the true thing.
      -->
      <div class="mx-auto w-full max-w-thread flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <app-answer-pending
          label="Loading conversation"
          announcement="Loading this conversation."
        />
      </div>
    } @else {
      @if (chat.isEmpty()) {
        <!-- A conversation waiting for its first question. There is no page to
             show for nothing asked yet, so the space says what it is for and
             steps out of the way: the composer below is already the only thing
             to do, and copying it into the panel would make two of it. -->
        <div class="mx-auto w-full max-w-thread flex-1 px-4 py-8 sm:px-6 lg:px-8">
          <p class="text-sm text-muted-foreground">No questions yet.</p>
        </div>
      }

      <!-- The thread, empty or not. -->
      <app-chat-thread
        [messages]="chat.messages()"
        [isBusy]="chat.isLoading()"
        [canEdit]="!chat.isLoading()"
        (retry)="onRetry($event)"
        (edited)="onEdited($event)"
      />
    }

    <!-- Fixed below the scrollable area: shrink-0 keeps the composer at its own
         height, so the thread scrolls behind it instead of pushing it away. -->
    <div class="shrink-0 px-4 pb-4 sm:px-6 sm:pb-5 lg:px-8 lg:pb-6">
      <div class="mx-auto w-full max-w-thread">
        <app-question-input [isBusy]="chat.isLoading() || chat.isCreating()" (ask)="onAsk($event)" />
      </div>
    </div>
  `,
})
export class ResponseViewComponent {
  /** The open conversation. */
  protected readonly chat = inject(ChatService);

  private readonly route = inject(ActivatedRoute);

  /**
   * The `:id` segment, which decides which conversation is shown. Null on
   * `/response`, where the last active conversation is followed instead.
   */
  private readonly conversationId = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id'))),
    { initialValue: null },
  );

  /**
   * Route-driven state: whenever the id changes, that conversation is opened.
   * Navigating away and back, and picking another conversation from the sidebar,
   * both restore the right thread.   *
   * The id is read tracked on purpose: it is the one input this effect exists to
   * react to, so a change to it is exactly when the thread should be re-opened.
   */
  private readonly openRoutedConversation = effect(() => {
    const id = this.conversationId();

    if (id) {
      this.chat.openConversation(id);
    }
  });

  /**
   * A conversation that is not there sends the reader back to a window with none.
   *
   * Left as a dead end, the address bar kept naming a conversation the app had
   * stopped showing, and every question typed into it would have gone nowhere —
   * which reads as the assistant losing the thread rather than as the link being
   * old. The home route is also the only place with nothing selected in the
   * sidebar, so it is where "there is no conversation here" is said by the state of
   * the screen rather than by a message about one that has gone.
   */
  private readonly leaveMissingConversation = effect(() => {
    if (this.chat.isMissing()) {
      void this.router.navigateByUrl(this.auth.assistantPath());
    }
  });

  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** Asks a follow-up question inside the open conversation. */
  protected onAsk(question: string): void {
    this.chat.ask(question);
  }

  /** Asks a failed message's question again. */
  protected onRetry(messageId: string): void {
    this.chat.retry(messageId);
  }

  /**
   * Corrects a question and asks it again.
   *
   * The service owns the sequence — store the correction, drop the answer written for
   * the old wording, ask the new one — because getting that order wrong would leave
   * the thread showing an answer to words that are no longer on screen.
   */
  protected onEdited(edit: { id: string; content: string }): void {
    this.chat.editQuestion(edit.id, edit.content);
  }
}
