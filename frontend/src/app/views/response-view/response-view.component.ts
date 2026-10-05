import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

import { ChatService } from '../../core/services/chat.service';
import { QuestionInputComponent } from '../../features/ask/components/question-input/question-input.component';
import { ViewHeaderComponent } from '../../features/chat/components/view-header/view-header.component';
import { ChatThreadComponent } from '../../features/response/components/chat-thread/chat-thread.component';
import { SkeletonComponent } from '../../shared/components/skeleton/skeleton.component';

/**
 * Shows one conversation: its whole thread and the composer for follow-up
 * questions. A view only assembles components and connects them to services.
 *
 * The route's `:id` is the conversation's own id, and a conversation's id never
 * changes, so a link to one keeps working however long afterwards it is followed.
 * It is optional: `/response` with no id follows the conversation that was last
 * active, which is where a question sent from the dashboard lands.
 */
@Component({
  selector: 'app-response-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ChatThreadComponent,
    QuestionInputComponent,
    SkeletonComponent,
    ViewHeaderComponent,
  ],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <!-- Fixed above the scrollable area: reading back through a long conversation
         moves the messages under it and never takes the title with them. -->
    <app-view-header [title]="chat.threadTitle()" />

    @if (chat.isResolving()) {
      <!--
        A conversation is on its way. Skeleton cards in the shape of the thread,
        not a spinner: this is a stored thread being read back, and it arrives as
        cards, so the placeholders are cards. Nothing here is being thought up,
        so thinking bubbles would claim work that is not happening.
      -->
      <div class="mx-auto w-full max-w-thread flex-1 px-4 py-6 sm:px-6 lg:px-8" aria-hidden="true">
        <div class="flex flex-col gap-5">
          <div class="flex justify-end">
            <app-skeleton class="h-10 w-44 rounded-2xl sm:w-56" />
          </div>

          <div class="rounded-lg border border-border bg-card p-4">
            <app-skeleton class="h-3.5 w-40" />
            <app-skeleton class="mt-2.5 h-2.5 w-full" />
            <app-skeleton class="mt-1.5 h-2.5 w-11/12" />
            <app-skeleton class="mt-1.5 h-2.5 w-3/5" />
            <div class="mt-3 flex gap-1.5">
              <app-skeleton class="h-5 w-20 rounded-full" />
              <app-skeleton class="h-5 w-24 rounded-full" />
            </div>
          </div>

          <div class="flex justify-end">
            <app-skeleton class="h-10 w-32 rounded-2xl sm:w-44" />
          </div>

          <div class="rounded-lg border border-border bg-card p-4">
            <app-skeleton class="h-3.5 w-32" />
            <app-skeleton class="mt-2.5 h-2.5 w-full" />
            <app-skeleton class="mt-1.5 h-2.5 w-2/3" />
          </div>
        </div>
      </div>

      <span class="sr-only" role="status">Loading this conversation.</span>
    } @else if (chat.isMissing()) {
      <!-- A link to a conversation that is gone: deleted, or belonging to another
           client. Said plainly, rather than as an empty thread, which would read
           as a conversation that had lost its history. -->
      <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <h2 class="font-headings text-lg font-semibold text-foreground">Conversation not found</h2>
        <p class="max-w-sm text-sm leading-relaxed text-muted-foreground">
          This conversation is not in this browser's list. It may have been deleted.
        </p>
      </div>
    } @else {
      <!-- The thread, empty or not. A conversation waiting for its first
           question shows the composer and nothing else: there is no page to show
           for nothing asked yet. -->
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
        <app-question-input [isBusy]="chat.isLoading()" (ask)="onAsk($event)" />
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
