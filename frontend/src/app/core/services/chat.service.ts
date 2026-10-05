import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  Observable,
  catchError,
  finalize,
  map,
  mergeMap,
  of,
  reduce,
  switchMap,
  throwError,
} from 'rxjs';

import { SourceDto } from '../models/api.model';
import { UNTITLED_CONVERSATION } from '../models/conversation.model';
import { SourceReference } from '../models/message.model';
import { ApiError, ApiService, STREAM_INCOMPLETE_MESSAGE } from './api.service';
import { ConversationService } from './conversation.service';
import { IdentityService } from './identity.service';

/**
 * Owns the open conversation while a question is in flight: what is being asked,
 * what the answer is doing, and what a failure leaves behind.
 *
 * The conversation itself lives in `ConversationService`, which is backed by the
 * backend's own record of it. This service keeps no copy of the thread and never
 * decides which conversation a question belongs to beyond the one that is open:
 * that is the single thing that makes a follow-up a follow-up rather than the
 * start of a second conversation, so there is one decision to get right and it is
 * made here, in one place, on every question.
 */
@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly api = inject(ApiService);
  private readonly conversations = inject(ConversationService);
  private readonly identity = inject(IdentityService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly askingState = signal(false);

  /**
   * True between the backend saying the answer is being written and its first
   * words arriving.
   *
   * The configured model works before it writes its first word, and that work is
   * not the answer, so it is not shown. Without this the thread would sit on a
   * spinner for all of it, which reads as a broken app rather than as a slow one.
   */
  private readonly preparingState = signal(false);

  /** True while an answer is being worked on but has no text to show yet. */
  readonly isPreparing = this.preparingState.asReadonly();

  /** True while a question is being sent or an answer is being retrieved. */
  readonly isLoading = this.askingState.asReadonly();

  /** The open conversation's messages, oldest first. */
  readonly messages = this.conversations.messages;

  /** The open conversation's id, or null when none is open. */
  readonly activeConversationId = this.conversations.activeId;

  /**
   * True until the conversation's messages are known.
   *
   * Covers both the list arriving and the thread itself, so the view can tell
   * "still loading" from "loaded and empty" and never show a not-found page for a
   * conversation that is simply on its way.
   */
  readonly isResolving = computed(
    () => !this.conversations.isLoaded() || this.conversations.isLoadingThread(),
  );

  /** True once the open conversation has something to render. */
  readonly hasMessages = computed(() => this.messages().length > 0);

  /**
   * True when the conversation is loaded and holds no messages at all.
   *
   * Distinct from having no open conversation. An empty one is a conversation
   * waiting for its first question, which is what a first visit lands on and what
   * the view would otherwise misreport as a missing conversation.
   */
  readonly isEmpty = computed(() => !this.isResolving() && this.messages().length === 0);

  /**
   * True when the conversation this route names is not there.
   *
   * A link to a conversation that was deleted, or that belongs to another client,
   * is answered with this rather than with an empty thread: an empty thread would
   * read as a conversation that has lost its history, which is the opposite of
   * what happened.
   */
  readonly isMissing = this.conversations.isMissing;

  /**
   * Title shown in the thread header.
   *
   * The conversation's own name once it has one, and a neutral label while it does
   * not: a fresh conversation is not an error, so it is not titled as one.
   */
  readonly threadTitle = computed(
    () => this.conversations.activeConversation()?.title ?? UNTITLED_CONVERSATION,
  );

  /**
   * Asks a question, in the open conversation or in a new one.
   *
   * This is the only place a conversation is created, and it is created here because
   * this is the first moment there is something to put in one. Opening the app, or
   * pressing "New conversation", leaves no conversation on the server and none in the
   * sidebar: both of those only empty the thread, and the id is taken when a question
   * is actually sent.
   *
   * Both halves of the exchange are recorded before the request goes out, so the
   * thread shows the question and its pending answer straight away rather than
   * after the round trip.
   *
   * The conversation is resolved first, because there is nothing to add a message
   * to until there is one. A question asked on a first visit waits for the list to
   * arrive rather than being dropped, which is the difference between a question
   * that works and one that vanishes the first time it is asked.
   */
  ask(question: string): void {
    const trimmed = question.trim();

    if (!trimmed) {
      return;
    }

    this.conversations
      .ready()
      .pipe(
        // Read after waiting: the open conversation is decided by the list that
        // was just fetched, and reading it before the wait would be reading the
        // state this question is waiting for.
        switchMap(() => {
          const open = this.conversations.activeId();

          if (open !== null) {
            return of(open);
          }

          // No conversation is open — a first visit, or "New conversation" — so this
          // question starts one. The create is shared, so a second question sent
          // before the first answer lands joins this conversation rather than opening
          // another alongside it.
          return this.conversations.createConversation().pipe(map((created) => created.id));
        }),
        switchMap((conversationId) => {
          const exchange = this.conversations.appendExchange(trimmed);

          return this.dispatch(conversationId, exchange.assistantId, trimmed);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  /**
   * Asks a failed exchange's question again.
   *
   * The failed answer and its question are taken out and the question asked again
   * in their place, so a retried exchange does not stack a second copy under the
   * failure it is retrying. A retried question does appear twice in the stored
   * conversation once it is refetched, because the backend records every message
   * sent; there is no endpoint that removes one.
   */
  retry(messageId: string): void {
    if (this.askingState()) {
      return;
    }

    const question = this.questionFor(messageId);
    const conversationId = this.conversations.activeId();

    if (question === null || !conversationId) {
      return;
    }

    this.conversations.removeExchange(messageId);

    const exchange = this.conversations.appendExchange(question);

    this.dispatch(conversationId, exchange.assistantId, question)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /**
   * Starts a new conversation.
   *
   * Unsaved, and deliberately so. This empties the thread and points the composer at
   * nothing; it does not create anything, because a conversation nobody has said
   * anything in is not one. The conversation this leaves behind stays in the sidebar
   * — which is the whole point of conversations outliving the question that started
   * them — and the next question asked opens a new one, which is created at that
   * moment and appears in the list once there is something in it.
   */
  startNewConversation(): void {
    this.conversations.startUnsaved();
  }

  /** Opens an existing conversation, loading its thread. */
  openConversation(conversationId: string): void {
    this.conversations.openConversation(conversationId);
  }

  /**
   * The question a failed answer belongs to, or null when there is none.
   *
   * A message carries its own id, so the question is the message before it in the
   * thread. That is the same relationship the backend stores, so it holds for a
   * conversation loaded from the backend as well as for one being answered here.
   */
  private questionFor(messageId: string): string | null {
    const messages = this.messages();
    const index = messages.findIndex((message) => message.id === messageId);

    if (index === -1) {
      return null;
    }

    for (let at = index - 1; at >= 0; at -= 1) {
      const message = messages[at];

      if (message.role === 'user') {
        return message.text;
      }
    }

    return null;
  }

  /**
   * Sends one question and writes the outcome back onto its answer message.
   *
   * The answer is streamed: each piece is appended to the message as it arrives,
   * so the thread writes the answer out rather than showing a spinner and then
   * replacing it with the finished text. `done` is what settles the message, and it
   * carries the authoritative answer, so a refusal or a gap in the corpus still
   * ends up worded the same way the backend words it.
   *
   * A failure mid-stream leaves whatever was already written on the message, since
   * the message is never left searching forever and the user has something to
   * retry from.
   */
  private dispatch(
    conversationId: string,
    messageId: string,
    question: string,
  ): Observable<null> {
    this.askingState.set(true);
    this.preparingState.set(false);

    return this.stream(conversationId, question, messageId).pipe(
      map((answer) => {
        this.conversations.resolveMessage(messageId, answer);
        // The backend stamps the conversation as active when it stores the answer,
        // and the list is ordered by that. Re-reading it here is what lifts a
        // conversation that was answered now to the top of the sidebar, instead of
        // leaving it where it was the last time the page loaded.
        this.conversations.refreshSummaries();

        return null;
      }),
      catchError((error: unknown) => {
        this.preparingState.set(false);
        this.conversations.failMessage(messageId, this.describeFailure(error));

        return of(null);
      }),
      finalize(() => {
        this.askingState.set(false);
        this.preparingState.set(false);
      }),
    );
  }

  /**
   * One streamed question, resolved to the same shape the answer is written with.
   *
   * A stream that ends without a `done` is treated as a failure rather than as an
   * empty answer: a connection dropped mid-answer has produced no answer, and
   * reporting it as "not found in the documents" would blame the corpus for it.
   */
  private stream(
    conversationId: string,
    question: string,
    messageId: string,
  ): Observable<{ text: string; status: 'answered' | 'not-found'; sources: SourceReference[] }> {
    return this.api.sendMessage(conversationId, this.identity.clientId(), question).pipe(
      reduce(
        (answer, event) => {
          if (event.type === 'status') {
            this.preparingState.set(true);

            return answer;
          }

          if (event.type === 'delta') {
            // Text has started arriving, so whatever was said about writing the
            // answer has been overtaken by the real thing.
            this.preparingState.set(false);
            this.conversations.appendStreamedText(messageId, event.text);

            return answer;
          }

          if (event.type === 'title') {
            // The conversation's name, sent once after the first answer. Applied
            // whether or not this is the conversation on screen: a user who
            // switched conversations mid-answer should still see it named in the
            // sidebar.
            this.conversations.applyTitle(conversationId, event.title);

            return answer;
          }

          if (event.type === 'error') {
            throw new ApiError(event.detail, 0, true);
          }

          return {
            text: event.answer,
            status: event.answered ? ('answered' as const) : ('not-found' as const),
            sources: event.sources.map((dto) => this.toSource(dto)),
          };
        },
        null as { text: string; status: 'answered' | 'not-found'; sources: SourceReference[] } | null,
      ),
      mergeMap((answer) =>
        answer === null ? throwError(() => new ApiError(STREAM_INCOMPLETE_MESSAGE, 0, true)) : of(answer),
      ),
    );
  }

  /** A wire source as the domain shape, matching `ApiService`'s own mapping. */
  private toSource(dto: SourceDto): SourceReference {
    return {
      document: dto.document,
      section: dto.section,
      snippet: dto.snippet,
      score: dto.score,
    };
  }

  /**
   * What a failed answer says. A question the backend rejected is the user's to
   * fix, so its own wording is passed through with a nudge to rephrase; anything
   * else reads as temporary and invites a retry.
   */
  private describeFailure(error: unknown): string {
    if (error instanceof ApiError) {
      return error.isTransient ? error.message : `${error.message} Try rephrasing your question.`;
    }

    return 'Something went wrong reaching the assistant. Please try again.';
  }
}
