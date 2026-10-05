import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, throwError, timeout } from 'rxjs';

import { ConfigService } from '../config.service';
import { API_TIMEOUT_MS } from '../api.config';
import {
  ChatStreamEventDto,
  ConversationCreateResponse,
  ConversationDetailResponse,
  ConversationListResponse,
  ConversationSummaryDto,
  MessageDto,
  MessageSendRequest,
  SourceDto,
  parseUtcTimestamp,
} from '../models/api.model';
import { Conversation, ConversationThread } from '../models/conversation.model';
import {
  AnswerStatus,
  Message,
  SourceReference,
  countDocuments,
  toKnownAnswerStatus,
} from '../models/message.model';
import { AuthService, CSRF_HEADER } from './auth.service';

/**
 * How a stored message should be rendered.
 *
 * The backend records the outcome on the row, so this is read rather than guessed,
 * and a conversation reopened tomorrow draws the same cards it did when it was
 * being answered.
 *
 * Two fallbacks, both about rows that predate the field. A question carries no
 * outcome at all and is never anything but answered, and an assistant row with no
 * recorded status and no citations is a miss — which is all the evidence such a row
 * has, and is why those older threads may draw a greeting as a not-found until they
 * are asked again.
 */
function toAnswerStatus(dto: MessageDto): AnswerStatus {
  if (dto.role === 'user') {
    return 'answered';
  }

  return toKnownAnswerStatus(dto.status) ?? (dto.sources?.length ? 'answered' : 'not-found');
}

/** An error from the backend, already reduced to something a view can show. */
export class ApiError extends Error {
  constructor(
    override readonly message: string,
    /** HTTP status, or 0 when the request never reached the backend. */
    readonly status: number,
    /** True when retrying the same request could plausibly succeed. */
    readonly isTransient: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Shown when a stream ends without a `done` event.
 *
 * A connection dropped part way through has produced no answer at all, which is
 * different from an answer saying the corpus holds nothing, so it is reported as a
 * temporary failure and stays retryable.
 */
export const STREAM_INCOMPLETE_MESSAGE =
  'The connection to the assistant was interrupted before the answer finished. Please try again.';

/**
 * The only place that talks to the backend. Components never inject
 * `HttpClient` themselves; they go through the feature services, which in turn
 * call this one.
 *
 * Two layers meet here. The methods return the backend's own wire types, so the
 * shape of the HTTP contract is readable in one place, and the mappers turn them
 * into the domain models the rest of the app uses. Backend changes land in a mapper
 * instead of rippling outward.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  /**
   * The session lives in cookies, so every call has to be allowed to carry them.
   *
   * A cross-origin request without `withCredentials` silently drops both the
   * cookies it should send and the ones the server is trying to set, which is what
   * makes authentication look wired up and behave as though it were not.
   */
  private readonly credentials = { withCredentials: true } as const;

  private readonly auth = inject(AuthService);

  private get baseUrl(): string {
    return this.config.getApiBaseUrl();
  }

  /**
   * `POST /api/conversations`. Opens a conversation for this client.
   *
   * Only ever called for a conversation the user asked to start. A message posted
   * to an existing conversation appends to it, so asking a follow-up never lands
   * the user in a new one.
   */
  createConversation(clientId: string): Observable<ConversationCreateResponse> {
    return this.post<ConversationCreateResponse>('/api/conversations', { client_id: clientId });
  }

  /**
   * `GET /documents`. The titles in the indexed corpus.
   *
   * The only read the admin area has of what is actually indexed. It is a bare list
   * of names rather than a document record — no sizes, no status, no uploader — so
   * it can answer "how much is in there" and nothing finer. Anything wanting more
   * than that needs a backend endpoint of its own rather than a richer reading of
   * this one.
   */
  getIndexedDocuments(): Observable<string[]> {
    return this.get<string[]>('/documents');
  }

  /**
   * `GET /api/conversations`. Every conversation this account owns, newest first.
   *
   * No `client_id`, and deliberately: the backend scopes the list by the account in
   * the session, so a person's threads follow them to another browser and cannot be
   * widened by anything sent from here.
   */
  getConversations(): Observable<Conversation[]> {
    return this.get<ConversationListResponse>('/api/conversations').pipe(
      map((response) => response.conversations.map((dto) => this.toConversation(dto))),
    );
  }

  /**
   * `GET /api/conversations/{id}`. One conversation's whole thread, oldest first.
   *
   * Ordered oldest first by the backend, which is the order a conversation reads
   * in, so it is used as it arrives. Ownership is the account's, so nothing is sent
   * to widen it.
   */
  getConversation(conversationId: string): Observable<ConversationThread> {
    const path = `/api/conversations/${encodeURIComponent(conversationId)}`;

    return this.get<ConversationDetailResponse>(path).pipe(
      map((response) => ({
        id: response.id,
        title: response.title,
        messages: response.messages.map((dto) => this.toMessage(dto)),
      })),
    );
  }

  /** `POST /api/conversations/{id}/messages`. Asks, and emits the answer as written. */
  sendMessage(
    conversationId: string,
    clientId: string,
    content: string,
  ): Observable<ChatStreamEventDto> {
    return new Observable<ChatStreamEventDto>((subscriber) => {
      const controller = new AbortController();
      const body: MessageSendRequest = { client_id: clientId, content };
      // Emitted from inside the read loop, so the caller sees each piece of the
      // answer as it lands rather than when the stream ends.
      const emit = (event: ChatStreamEventDto): void => {
        if (!controller.signal.aborted) {
          subscriber.next(event);
        }
      };

      void this.readStream(conversationId, body, controller.signal, emit).then(
        () => subscriber.complete(),
        (error: unknown) => {
          if (!controller.signal.aborted) {
            subscriber.error(this.toApiError(error));
          }
        },
      );

      return () => controller.abort();
    });
  }

  /** `PATCH /api/conversations/{id}`. Names a conversation. */
  renameConversation(conversationId: string, clientId: string, title: string): Observable<void> {
    const path = `/api/conversations/${encodeURIComponent(conversationId)}`;

    return this.patch<void>(path, { client_id: clientId, title }).pipe(map(() => undefined));
  }

  /**
   * `PATCH /api/conversations/{id}/messages/{message_id}`. Corrects a question.
   *
   * The backend removes the answer that was generated from the old wording and
   * returns the corrected question; the caller is expected to ask it again, so what
   * the reader ends up looking at was written for the words on screen.
   */
  editMessage(
    conversationId: string,
    messageId: string,
    clientId: string,
    content: string,
  ): Observable<MessageDto> {
    const path =
      `/api/conversations/${encodeURIComponent(conversationId)}` +
      `/messages/${encodeURIComponent(messageId)}`;

    return this.patch<MessageDto>(path, { client_id: clientId, content });
  }

  /** `DELETE /api/conversations/{id}`. Removes a conversation and its messages. */
  deleteConversation(conversationId: string): Observable<void> {
    const path = `/api/conversations/${encodeURIComponent(conversationId)}`;

    return this.send(this.http.delete<void>(`${this.baseUrl}${path}`, this.credentials)).pipe(
      map(() => undefined),
    );
  }

  /**
   * Reads a `text/event-stream` body, handing each event to `onEvent` as it is
   * parsed.
   *
   * Events are separated by a blank line and may arrive split across network
   * chunks, so the buffer is only drained on a complete frame and whatever follows
   * the last newline is kept for the next read.
   *
   * Raw `fetch` rather than `HttpClient`, because `HttpClient` reads a response to
   * completion before handing it over and a stream has to be read as it arrives.
   * That means this call gets none of the interceptor's work for free and has to do
   * two of its jobs itself: send the session cookies, and send the CSRF header. A
   * request made this way without them is refused by the server, which is the correct
   * outcome rather than a papering-over.
   */
  private async readStream(
    conversationId: string,
    body: MessageSendRequest,
    abort: AbortSignal,
    onEvent: (event: ChatStreamEventDto) => void,
  ): Promise<void> {
    let response = await this.postStream(conversationId, body, abort);

    // The access token may have run out between page load and the first question.
    // The interceptor does this for every `HttpClient` request; this one has to ask
    // for itself, and only once, since a second refresh would arrive after the first
    // had already rotated the token.
    if (response.status === 401 && this.auth.isAuthenticated()) {
      const user = await this.auth.refresh();

      if (user) {
        response = await this.postStream(conversationId, body, abort);
      }
    }

    if (!response.ok) {
      throw new HttpErrorResponse({
        status: response.status,
        error: await this.readErrorBody(response),
      });
    }

    if (!response.body) {
      throw new HttpErrorResponse({ status: response.status, error: null });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');

      while (boundary !== -1) {
        const event = this.parseFrame(buffer.slice(0, boundary));

        if (event) {
          onEvent(event);
        }

        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  /** One attempt at the streamed answer, with the cookies and the CSRF header on it. */
  private async postStream(
    conversationId: string,
    body: MessageSendRequest,
    abort: AbortSignal,
  ): Promise<Response> {
    try {
      return await fetch(
        `${this.baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [CSRF_HEADER]: this.auth.readCsrfToken() ?? '',
          },
          // What `withCredentials` does for `HttpClient`, done by hand here.
          credentials: 'include',
          body: JSON.stringify(body),
          signal: abort,
        },
      );
    } catch {
      // fetch reports a dropped connection and a refused request the same way,
      // which is the status-0 case the rest of this service already describes.
      throw new HttpErrorResponse({ status: 0, error: null });
    }
  }

  /**
   * The JSON body of a failed response, or null when it is not JSON.
   *
   * A proxy in front of the backend can answer with HTML of its own, which is
   * a status to report rather than a body to read.
   */
  private async readErrorBody(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  /** One SSE frame as an event, or null for a frame that carries no payload. */
  private parseFrame(frame: string): ChatStreamEventDto | null {
    const payload = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');

    if (!payload) {
      return null;
    }

    try {
      return JSON.parse(payload) as ChatStreamEventDto;
    } catch {
      // A frame that is not JSON is not something this client can act on, and
      // dropping it keeps the rest of the stream usable.
      return null;
    }
  }

  /**
   * A GET against a path, with the timeout and the error mapping applied.
   *
   * Paths are spelled out in full at every call site rather than being assembled
   * from a base inside a shared helper. Handing each caller the bare base URL
   * instead made it possible to send a request to the origin with no path at all,
   * which is a request that cannot fail loudly.
   */
  private get<T>(path: string): Observable<T> {
    return this.send(this.http.get<T>(`${this.baseUrl}${path}`, this.credentials));
  }

  /** A POST against a path, with the timeout and the error mapping applied. */
  private post<T>(path: string, body: unknown): Observable<T> {
    return this.send(this.http.post<T>(`${this.baseUrl}${path}`, body, this.credentials));
  }

  /** A PATCH against a path, with the timeout and the error mapping applied. */
  private patch<T>(path: string, body: unknown): Observable<T> {
    return this.send(this.http.patch<T>(`${this.baseUrl}${path}`, body, this.credentials));
  }

  /** Applies the request timeout and flattens transport failures into `ApiError`. */
  private send<T>(request: Observable<T>): Observable<T> {
    return request.pipe(
      timeout(API_TIMEOUT_MS),
      catchError((error: unknown) => throwError(() => this.toApiError(error))),
    );
  }

  /** A wire conversation as the domain shape. */
  private toConversation(dto: ConversationSummaryDto): Conversation {
    return {
      id: dto.id,
      title: dto.title,
      updatedAt: parseUtcTimestamp(dto.updated_at),
    };
  }

/**
   * A wire message as the domain shape.
   *
   * `sources` is null on a question, which cites nothing, so it becomes an empty
   * list rather than a nullable field every consumer would have to check. The
   * status is derived here rather than stored: a message that is in the backend is
   * finished, and only a locally streamed one is still pending or has failed.
   */
  private toMessage(dto: MessageDto): Message {
    const sources = (dto.sources ?? []).map((source) => this.toSource(source));

    return {
      id: dto.id,
      role: dto.role,
      text: dto.content,
      createdAt: parseUtcTimestamp(dto.created_at),
      status: toAnswerStatus(dto),
      sources,
      documentCount: countDocuments(sources),
      confidence: dto.confidence ?? null,
    };
  }

  /** Turns a wire source into the domain shape. */
  private toSource(dto: SourceDto): SourceReference {
    return {
      document: dto.document,
      section: dto.section,
      snippet: dto.snippet,
      score: dto.score,
    };
  }

  /**
   * A failure worth showing a user.
   *
   * A browser reports a request the network dropped and a request the server
   * answered without CORS headers identically, as a status of 0, so those are
   * described together: from here they are the same thing and saying otherwise
   * would be a distinction the page cannot actually make.
   *
   * A 422 means the message itself was rejected, so the backend's own wording is
   * passed through; a 5xx means the answer may still be there and is worth
   * retrying. A 404 means the conversation is not there to answer into, which is
   * the one failure a retry cannot fix.
   */
  private toApiError(error: unknown): ApiError {
    if (error instanceof HttpErrorResponse) {
      const detail = this.readBackendDetail(error.error);

      // The backend's own wording, for any status that carries one.
      //
      // It is written for the person who hit it and says what to do next — "That
      // address already has an account", "Only your own questions can be edited" —
      // so replacing it with a generic sentence throws away the only part of the
      // failure the reader can act on. This used to apply to 422 alone, which meant a
      // 409's reason was read from a property `ApiError` does not have and was
      // therefore always lost.
      //
      // Status 0 and 5xx are the deliberate exceptions: there is no server wording
      // worth showing for a request that never arrived or failed inside the backend,
      // and a raw traceback is not something to put in front of anybody.
      if (detail && error.status !== 0 && error.status < 500) {
        return new ApiError(detail, error.status, error.status >= 500);
      }

      if (error.status === 0) {
        return new ApiError(
          'Could not get a response from the assistant. It may be temporarily unavailable.',
          0,
          true,
        );
      }

      if (error.status >= 500) {
        return new ApiError(
          'The assistant is temporarily unavailable. Please try again.',
          error.status,
          true,
        );
      }

      if (error.status === 404) {
        return new ApiError('That conversation is no longer available.', 404, false);
      }

      return new ApiError('The request could not be completed.', error.status, false);
    }

    if (error instanceof Error && error.name === 'TimeoutError') {
      return new ApiError('The assistant took too long to respond. Please try again.', 0, true);
    }

    return new ApiError('Something went wrong. Please try again.', 0, true);
  }

  /**
 * What the backend said went wrong, as a sentence.
 *
 * Handles both shapes a FastAPI failure arrives in: a plain `detail` string, which is
 * what an `HTTPException` carries, and the `detail` array a validation failure
 * produces, where the first entry's `msg` is the sentence.
 *
 * A 401 on a session check is deliberately not read. The backend sends "Sign in to
 * continue" and "Your session has ended. Please sign in again." on purpose, and
 * neither belongs in an error the interceptor is about to resolve by refreshing —
 * surfacing them would flash a message at somebody whose next request succeeds.
 */
  private readBackendDetail(body: unknown): string | null {
    if (typeof body !== 'object' || body === null || !('detail' in body)) {
      return null;
    }

    const { detail } = body as { detail: unknown };

    if (typeof detail === 'string') {
      return detail;
    }

    if (!Array.isArray(detail) || detail.length === 0) {
      return null;
    }

    const first = (detail as { msg?: unknown }[])[0];

    return typeof first?.msg === 'string' ? first.msg : null;
  }
}
