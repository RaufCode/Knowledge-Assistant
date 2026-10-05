import { isPlatformBrowser } from '@angular/common';
import {
  DestroyRef,
  Injectable,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, ReplaySubject, catchError, map, of, shareReplay, tap } from 'rxjs';

import { toDateBucket, type DateBucket } from '../../shared/utils/format-date.util';
import { Conversation } from '../models/conversation.model';
import { Message } from '../models/message.model';
import { ApiError, ApiService } from './api.service';
import { AuthService, type AuthStatus } from './auth.service';
import { IdentityService } from './identity.service';

/** List headings, in the order they are shown. */
const BUCKET_ORDER: DateBucket[] = ['Recent', 'Old'];

/** A run of conversations sharing one date heading. */
export interface ConversationGroup {
  bucket: DateBucket;
  conversations: Conversation[];
}

/**
 * Single source of truth for the conversations this browser has, and for the one
 * that is open. The sidebar, the conversations view and the thread all read from here,
 * so a conversation can never be listed in one place and missing from another.
 *
 * Two things are worth knowing about how the state is held:
 *
 * - The list comes from the backend, which owns it. Nothing here invents a
 *   conversation, so a reload shows the same list the last visit left, and a
 *   conversation asked in another tab appears without being asked for.
 * - The messages of the open conversation are held here too, rather than being
 *   re-fetched per view, so switching to another conversation and back does not
 *   re-read a thread that is already in memory.
 *
 * A conversation is never expired, retired or swapped out from under the user.
 * Asking a follow-up extends the conversation it belongs to, and a conversation
 * keeps its id for as long as it exists, so `/response/:id` is a link that still
 * works tomorrow.
 */
@Injectable({ providedIn: 'root' })
export class ConversationService {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly identity = inject(IdentityService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly conversationsState = signal<Conversation[]>([]);
  private readonly activeIdState = signal<string | null>(null);
  private readonly messagesState = signal<Message[]>([]);
  private readonly loadingState = signal(false);
  private readonly loadedState = signal(false);
  private readonly threadLoadingState = signal(false);
  private readonly searchTermState = signal('');

  /**
   * The conversation the backend has said is not there.
   *
   * Kept apart from "the open conversation is empty" because they mean opposite
   * things to the reader: one is a conversation waiting for its first question, and
   * the other is a link to something that is gone. Told the same way, a stale link
   * reads as a conversation that has lost its history.
   */
  private readonly missingState = signal<string | null>(null);

  /** Completes once the first load has settled, so callers can queue behind it. */
  private readonly settled = new ReplaySubject<void>(1);

  /** The session status the list was last brought in line with. */
  private settledFor: AuthStatus = 'unknown';

  /**
   * In-flight creation, shared so concurrent callers get the same conversation.
   *
   * Two calls at once would leave an empty conversation in the list that the user
   * never opened and never asked anything in.
   */
  private pendingCreate: Observable<Conversation> | null = null;

  /** Every conversation, most recently active first. */
  readonly conversations = this.conversationsState.asReadonly();

  /** The open conversation's id, or null when none is open. */
  readonly activeId = this.activeIdState.asReadonly();

  /** The open conversation's messages, oldest first. */
  readonly messages = this.messagesState.asReadonly();

  /** True while the list is being fetched for the first time. */
  readonly isLoading = this.loadingState.asReadonly();

  /** True once a list load has finished, successfully or not. */
  readonly isLoaded = this.loadedState.asReadonly();

  /** True while the open conversation's messages are being fetched. */
  readonly isLoadingThread = this.threadLoadingState.asReadonly();

  /** Current sidebar / conversations search term. */
  readonly searchTerm = this.searchTermState.asReadonly();

  /** The open conversation, as the sidebar and the header name it. */
  readonly activeConversation = computed(
    () => this.conversationsState().find((item) => item.id === this.activeIdState()) ?? null,
  );

  /** Conversations matching the search term. */
  readonly filteredConversations = computed(() => {
    const term = this.searchTermState().trim().toLowerCase();

    if (!term) {
      return this.conversationsState();
    }

    return this.conversationsState().filter((conversation) =>
      (conversation.title ?? '').toLowerCase().includes(term),
    );
  });

  /**
   * Filtered conversations grouped into the two list headings, always `Recent`
   * first so a search that only matches old conversations does not reorder them.
   */
  readonly groups = computed<ConversationGroup[]>(() => {
    const grouped = new Map<DateBucket, Conversation[]>();

    for (const conversation of this.filteredConversations()) {
      const bucket = toDateBucket(conversation.updatedAt);
      grouped.set(bucket, [...(grouped.get(bucket) ?? []), conversation]);
    }

    return BUCKET_ORDER.filter((bucket) => grouped.has(bucket)).map((bucket) => ({
      bucket,
      conversations: grouped.get(bucket) ?? [],
    }));
  });

  /** True when this browser has at least one conversation. */
  readonly hasConversations = computed(() => this.conversationsState().length > 0);

  /** True when a search is active and matched nothing. */
  readonly hasNoResults = computed(
    () => this.searchTermState().trim().length > 0 && this.filteredConversations().length === 0,
  );

  /**
   * True when the open conversation is not there to be shown.
   *
   * Only once nothing is in flight, so a link that is merely on its way is never
   * reported as a link to nothing.
   */
  readonly isMissing = computed(() => {
    const missing = this.missingState();

    if (missing === null || missing !== this.activeIdState()) {
      return false;
    }

    return this.loadedState() && !this.threadLoadingState();
  });

  constructor() {
    // Skipped on the server. Conversations belong to a client id, and a server
    // render would otherwise pay the round trip on every request to paint a list
    // the client is about to fetch anyway.
    if (this.isBrowser) {
      // The list waits for a session rather than asking and being refused. Every
      // conversation route is behind the session wall, so a request made before the
      // cookie has been checked is a guaranteed 401 — and the failure it produced
      // was a console error and an empty sidebar rather than an honest "nobody is
      // signed in".
      //
      // Applied once directly as well as through the effect, because on a page load
      // the app initializer has usually already answered by the time this is built.
      // That makes the common case — arriving signed in — fetch straight away, the
      // way it did before there was a session to wait for.
      this.syncToSession(this.auth.status());

      // Watching the status is what makes the list appear after a sign-in without
      // anything else having to ask for it, and disappear again after a sign-out.
      effect(() => this.syncToSession(this.auth.status()));

      return;
    }

    // Loaded stays false here on purpose. `ChatService.isResolving` is the negation
    // of it, and the response view reads that as "still loading" before it reads
    // the conversations themselves. Marking this loaded on the server therefore
    // produced `hasMessages() === false` with nothing pending, which the view
    // rendered as "not found" and shipped inside the served HTML. Leaving it
    // unresolved renders the loading card instead, which is both true of the
    // server's own knowledge and correct for the client, which is about to resolve
    // it. Settling still happens, so anything queueing on `ready()` is released.
    this.markSettled();
  }

  /**
   * Completes when the initial load has settled, immediately if it already has.
   *
   * Asks queue behind this so a question is never sent before the app knows which
   * conversation it is being added to.
   */
  ready(): Observable<void> {
    return this.settled.asObservable();
  }

  /**
   * Brings the list in line with the session.
   *
   * Guarded on the last status acted on rather than called for every reading of the
   * signal, so the effect and the direct call in the constructor cannot both fetch.
   */
  private syncToSession(status: AuthStatus): void {
    if (status === this.settledFor) {
      return;
    }

    this.settledFor = status;

    if (status === 'authenticated') {
      this.load();
      return;
    }

    if (status === 'anonymous') {
      this.showSignedOut();
    }
  }

  /**
   * The state of a browser with nobody signed in: no conversations, and nothing
   * pending.
   *
   * Settled rather than left waiting. Anything queueing on the first load — a
   * question typed the instant the shell appears — has to be released, or it would
   * sit behind a list that is never coming.
   */
  private showSignedOut(): void {
    this.conversationsState.set([]);
    this.activeIdState.set(null);
    this.messagesState.set([]);
    this.missingState.set(null);
    this.loadingState.set(false);
    this.loadedState.set(true);
    this.markSettled();
  }

  /**
   * Fetches this browser's conversations and opens the most recent one.
   *
   * Nothing is created here. Opening the app, or finding no conversations at all,
   * leaves no conversation behind: there is nothing to have asked, so there is
   * nothing to keep. A conversation is created when a question is actually sent —
   * see `ChatService.ask` — which is the first moment there is anything in one.
   */
  load(): void {
    this.loadingState.set(true);

    this.api
      .getConversations(this.identity.clientId())
      .pipe(
        catchError((error: unknown) => {
          console.error('Could not load conversations', error);

          return of<Conversation[]>([]);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((conversations) => {
        this.conversationsState.set(conversations);
        this.loadingState.set(false);
        this.loadedState.set(true);

        const mostRecent = conversations[0];

        if (!mostRecent) {
          // A first visit. The thread stays empty and no conversation is opened,
          // which is the state the view already knows how to describe: a conversation
          // waiting for its first question. Asking one creates the conversation, so
          // nothing is on the server until there is a question on it.
          this.markSettled();
          return;
        }

        // A conversation the route already asked for wins over the newest one. The
        // list and the thread come back independently, and opening the most recent
        // here unconditionally would replace the conversation a refresh was showing
        // with a different one, which is the same as losing it.
        if (this.activeIdState() === null) {
          this.openConversation(mostRecent.id);
        }

        this.markSettled();
      });
  }

  /**
   * Prepares a new conversation in the UI without creating one.
   *
   * This is what "New conversation" does: the thread is emptied and the composer is
   * pointed at nothing, and that is the whole of it. No request is made, no id is
   * taken, and the sidebar is unchanged — the conversation the person was in stays
   * in it, which is the point of a new conversation being a way to start another one
   * rather than a way to replace this one.
   *
   * What this leaves behind is deliberately *not* a conversation: there is no id, no
   * row, and nothing on the server. `ChatService.ask` creates the real one the moment
   * a question is sent into it.
   */
  startUnsaved(): void {
    this.activeIdState.set(null);
    this.messagesState.set([]);
    this.missingState.set(null);
    this.searchTermState.set('');
    this.threadLoadingState.set(false);
  }

  /**
   * Opens a new conversation and makes it the active one.
   *
   * Called only once there is a question for it — see `ChatService.ask`. The new
   * conversation is deliberately *not* added to the sidebar here: it has no messages
   * yet, and the list is re-read once the answer lands, at which point there is
   * something in it to list.
   *
   * De-duplicated: two callers asking at once share one request, so a double click
   * on "Send" leaves one conversation rather than two.
   */
  createConversation(): Observable<Conversation> {
    if (!this.pendingCreate) {
      this.pendingCreate = this.api.createConversation(this.identity.clientId()).pipe(
        map((response) => {
          const conversation: Conversation = {
            id: response.id,
            title: response.title,
            // A conversation created now is active now, and the backend timestamps
            // it the same way.
            updatedAt: new Date().toISOString(),
          };

          // Not added to the list. An id alone is not a conversation: with no message
          // in it there is nothing to list, and putting it there would show an
          // untitled row for as long as the answer took to arrive. `refreshSummaries`
          // puts it in once the exchange has been recorded.
          this.activeIdState.set(conversation.id);
          this.messagesState.set([]);

          return conversation;
        }),
        tap({
          // Cleared on both paths, so a failed create can be retried rather than
          // leaving a cached error behind forever.
          next: () => (this.pendingCreate = null),
          error: () => (this.pendingCreate = null),
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }

    return this.pendingCreate.pipe(takeUntilDestroyed(this.destroyRef));
  }

  /**
   * Re-reads the list from the backend, leaving the open thread as it is.
   *
   * Answering a message moves its conversation to the top of the list, which the
   * backend decides, and the list is ordered by when a conversation was last
   * active. Following a question up in a conversation from last week has to lift
   * it to the top of the sidebar as it is answered, not at the next reload.
   *
   * A failure here changes nothing: the list already in hand is the one the
   * backend last confirmed, and replacing it with nothing would take away
   * conversations that do exist.
   */
  refreshSummaries(): void {
    this.api
      .getConversations(this.identity.clientId())
      .pipe(
        catchError((error: unknown) => {
          console.error('Could not refresh conversations', error);

          return of<Conversation[] | null>(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((conversations) => {
        if (conversations === null) {
          return;
        }

        this.conversationsState.set(conversations);
        this.loadingState.set(false);
        this.loadedState.set(true);
      });
  }

  /**
   * Opens an existing conversation and loads its thread.
   *
   * An id that is not this browser's is a 404, which leaves the view with nothing
   * to render rather than showing a conversation that is not there.
   */
  openConversation(conversationId: string): void {
    this.activeIdState.set(conversationId);
    this.threadLoadingState.set(true);
    this.messagesState.set([]);
    this.missingState.set(null);

    this.api
      .getConversation(conversationId, this.identity.clientId())
      .pipe(
        catchError((error: unknown) => {
          // A conversation that is gone is not worth retrying, and it is not worth
          // an error on screen either: the list no longer offering it is half the
          // recovery, and the thread saying so is the other half. It is recorded
          // rather than swapped for another conversation, because a link that
          // silently showed a different thread would be a worse lie than saying the
          // one asked for is not there.
          if (error instanceof ApiError && error.status === 404) {
            this.missingState.set(conversationId);
            this.forget(conversationId);
          } else {
            console.error('Could not load the conversation', error);
          }

          return of<{ id: string; title: string | null; messages: Message[] } | null>(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((thread) => {
        // A conversation opened in the meantime wins: the thread that arrives now
        // belongs to a conversation the user has already left.
        if (thread === null || this.activeIdState() !== conversationId) {
          this.threadLoadingState.set(false);
          return;
        }

        this.messagesState.set(thread.messages);
        this.threadLoadingState.set(false);
        this.rememberTitle(conversationId, thread.title);
      });
  }

  /**
   * Names a conversation, once its first exchange has been answered.
   *
   * The title is applied wherever the conversation is listed rather than by
   * refetching the list, so the sidebar and the open thread's header are corrected
   * from the same value at the same moment.
   */
  applyTitle(conversationId: string, title: string): void {
    this.rememberTitle(conversationId, title);
  }

  /**
   * Records a question the moment it is asked, before any answer exists.
   *
   * Both halves of the exchange are added together: the assistant half starts
   * pending with no text, which is what the thread renders as an answer being
   * written. Ids are local, and the backend's own ids replace them on the next
   * load, so nothing here has to survive a reload.
   */
  appendExchange(question: string): { userId: string; assistantId: string } {
    const pairId = newLocalId();
    const createdAt = new Date().toISOString();

    this.messagesState.update((messages) => [
      ...messages,
      {
        id: `${pairId}-user`,
        role: 'user',
        text: question,
        createdAt,
        status: 'answered',
        sources: [],
        documentCount: 0,
      },
      {
        id: `${pairId}-assistant`,
        role: 'assistant',
        text: '',
        createdAt,
        status: 'pending',
        sources: [],
        documentCount: 0,
      },
    ]);

    return { userId: `${pairId}-user`, assistantId: `${pairId}-assistant` };
  }

  /** Appends a piece of a streaming answer to a message that is still pending. */
  appendStreamedText(messageId: string, text: string): void {
    this.patchMessage(messageId, (message) => ({ ...message, text: message.text + text }));
  }

  /**
   * Writes a completed answer onto a pending message.
   *
   * The sources come from the stream's closing event rather than from retrieval
   * alone, so the citation block only ever appears with the finished answer beside
   * it. A message that never gets that far is left with none, which is honest: an
   * answer that was interrupted was never shown to be grounded in anything.
   */
  resolveMessage(
    messageId: string,
    answer: { text: string; status: 'answered' | 'not-found'; sources: Message['sources'] },
  ): void {
    this.patchMessage(messageId, (message) => ({
      ...message,
      text: answer.text,
      status: answer.status,
      sources: answer.sources,
      documentCount: new Set(answer.sources.map((source) => source.document)).size,
    }));
  }

  /**
   * Marks a message as failed. The message is shown in place of an answer, so the
   * text is written onto it rather than kept on the side: there is one place a
   * message's text is read from.
   */
  failMessage(messageId: string, text: string): void {
    this.patchMessage(messageId, (message) => ({
      ...message,
      text,
      status: 'failed',
      sources: [],
      documentCount: 0,
    }));
  }

  /** Puts a message back to pending, so a retry shows the search state again. */
  markMessagePending(messageId: string): void {
    this.patchMessage(messageId, (message) => ({
      ...message,
      text: '',
      status: 'pending',
      sources: [],
      documentCount: 0,
    }));
  }

  /** The message with an id, or undefined when it is not in the open thread. */
  messageAt(messageId: string): Message | undefined {
    return this.messagesState().find((message) => message.id === messageId);
  }

  /**
   * Removes a failed answer and the question it was answering.
   *
   * A retry replaces its exchange rather than stacking a second copy under the
   * failure it is retrying, which would leave the reader looking at a card for
   * something that has already been asked again. Only the failed answer and the
   * question before it go: the rest of the thread is untouched, and the retried
   * exchange takes the same place.
   */
  removeExchange(messageId: string): void {
    this.messagesState.update((messages) => {
      const index = messages.findIndex((message) => message.id === messageId);

      if (index === -1) {
        return messages;
      }

      // The nearest question above the message, which is the one it answers.
      let questionAt = -1;

      for (let at = index - 1; at >= 0; at -= 1) {
        if (messages[at].role === 'user') {
          questionAt = at;
          break;
        }
      }

      return messages.filter((_, at) => at !== index && at !== questionAt);
    });
  }

  /**
   * Removes a conversation from this browser's list.
   *
   * The backend is not asked. This is how a conversation that has been deleted, or
   * that the backend no longer has, stops being offered.
   */
  forget(conversationId: string): void {
    this.conversationsState.update((conversations) =>
      conversations.filter((conversation) => conversation.id !== conversationId),
    );
  }

  /** Names a conversation, and asks the backend to remember the name. */
  renameConversation(conversationId: string, title: string): void {
    const trimmed = title.trim();

    if (!trimmed) {
      return;
    }

    this.rememberTitle(conversationId, trimmed);

    this.api
      .renameConversation(conversationId, this.identity.clientId(), trimmed)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ error: (error: unknown) => console.error('Could not rename', error) });
  }

  /**
   * Deletes a conversation and, if it was the open one, opens another.
   *
   * Deleting what the user is reading leaves them looking at nothing, so the next
   * conversation takes its place. When there was only the one, a new one is
   * created: an empty conversation is a conversation waiting for a question, which
   * is a better state than a composer with nowhere to send anything.
   */
  deleteConversation(conversationId: string): void {
    this.forget(conversationId);

    this.api
      .deleteConversation(conversationId, this.identity.clientId())
      .pipe(
        catchError((error: unknown) => {
          console.error('Could not delete the conversation', error);

          return of(undefined);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        if (this.activeIdState() !== conversationId) {
          return;
        }

        const next = this.conversationsState()[0];

        if (next) {
          this.openConversation(next.id);
          return;
        }

        // The last conversation is gone, so there is nothing to open. The composer is
        // left with an empty thread rather than being given a new conversation to
        // fill: the next question asked will create one.
        this.startUnsaved();
      });
  }

  /** Updates the search term shared by the sidebar and the conversations view. */
  setSearchTerm(term: string): void {
    this.searchTermState.set(term);
  }

  /** Clears the search term. */
  clearSearch(): void {
    this.searchTermState.set('');
  }

  /** Applies a change to one message, ignoring ids that are no longer present. */
  private patchMessage(messageId: string, change: (message: Message) => Message): void {
    this.messagesState.update((messages) =>
      messages.map((message) => (message.id === messageId ? change(message) : message)),
    );
  }

  /** Puts a title onto a conversation in the list, without disturbing the rest. */
  private rememberTitle(conversationId: string, title: string | null): void {
    if (title === null) {
      return;
    }

    this.conversationsState.update((conversations) =>
      conversations.map((conversation) =>
        conversation.id === conversationId ? { ...conversation, title } : conversation,
      ),
    );
  }

  /** Releases everything waiting on the first load, once or many times over. */
  /**
   * Releases everything waiting on the first load.
   *
   * Never completed, because a browser can be signed out, then in, and each of those
   * settles the load again. A `ReplaySubject(1)` replays the last one to anything
   * subscribing later, so a caller that arrives after the list is already here is
   * released immediately rather than waiting for a load that will not come again.
   */
  private markSettled(): void {
    this.settled.next();
  }
}

/** An id for a message pair that exists only in this browser, for now. */
function newLocalId(): string {
  return `local-${Math.random().toString(36).slice(2, 10)}`;
}
