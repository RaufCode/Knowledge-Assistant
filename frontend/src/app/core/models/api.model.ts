/**
 * Wire types, transcribed field for field from the backend's OpenAPI schema
 * (`GET /openapi.json`). These describe what travels over HTTP and nothing else.
 *
 * They are kept apart from the domain models on purpose. The backend is free to
 * rename or drop a field, and when it does, the change belongs in the mapping
 * inside `ApiService` rather than rippling through every component.
 */

/** One citation backing an answer. */
export interface SourceDto {
  document: string;
  section: string;
  /** The passage the answer was drawn from. */
  snippet: string;
  /**
   * Retrieval relevance. The schema documents neither its range nor its unit, so
   * it is carried through untouched and never rendered as a number.
   */
  score: number;
}

/** `POST /api/conversations` request body. */
export interface ConversationCreateRequest {
  /**
   * Who the conversation belongs to. The backend rejects ids shorter than 8 or
   * longer than 64 characters, and a conversation is only ever readable by the
   * client that sent the same value again.
   */
  client_id: string;
}

/** `POST /api/conversations` response. */
export interface ConversationCreateResponse {
  id: string;
  /** Null until the first exchange has been answered and the title generated. */
  title: string | null;
  /** ISO timestamp. The backend sends no timezone designator, so it is parsed as UTC. */
  created_at: string;
}

/** One conversation as `GET /api/conversations` lists it. */
export interface ConversationSummaryDto {
  id: string;
  title: string | null;
  /** When the conversation was last active, which is the order the list is in. */
  updated_at: string;
}

/** `GET /api/conversations` response. */
export interface ConversationListResponse {
  conversations: ConversationSummaryDto[];
}

/** `POST /api/conversations/{id}/messages` request body. */
export interface MessageSendRequest {
  client_id: string;
  /** The backend rejects messages shorter than 3 or longer than 500 characters. */
  content: string;
}

/** `PATCH /api/conversations/{id}` request body. */
export interface ConversationRenameRequest {
  client_id: string;
  title: string;
}

/** One message of a conversation, as `GET /api/conversations/{id}` returns it. */
export interface MessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Citations on an answered message. Null on a question, which cites nothing. */
  sources: SourceDto[] | null;
  created_at: string;
}

/** `GET /api/conversations/{id}` response: one conversation, oldest message first. */
export interface ConversationDetailResponse {
  id: string;
  title: string | null;
  messages: MessageDto[];
}

/**
 * One event of `POST /api/conversations/{id}/messages`.
 *
 * The `done` event is the authority on the answer: a `NOT_FOUND` and a
 * personal-record refusal are only knowable once the text is complete, so a client
 * renders the deltas as they arrive and then replaces them with what `done`
 * carries.
 */
export type ChatStreamEventDto =
  /**
   * Retrieval finished, before any answer text exists.
   *
   * The model reasons for a long time before its first word, so this is what the
   * client shows instead of a silent spinner. It replaces the loading indicator
   * and nothing else: the first `delta` supersedes it.
   */
  | { type: 'status'; stage: 'writing' }
  /** A piece of the answer, in order. */
  | { type: 'delta'; text: string }
  /** The final answer, and the citations that go with it. Exactly one. */
  | { type: 'done'; answer: string; answered: boolean; sources: SourceDto[] }
  /**
   * The conversation's name, sent once, after the first exchange is answered.
   *
   * The title is generated beside the answer rather than in front of it, so it
   * arrives after `done` and a client applies it to whatever it is currently
   * showing the conversation under.
   */
  | { type: 'title'; title: string }
  /** The stream failed. `detail` is already worded for a user to read. */
  | { type: 'error'; detail: string };

/** One entry of the `detail` array in a FastAPI 422 body. */
export interface ValidationErrorDto {
  loc: (string | number)[];
  msg: string;
  type: string;
}

/** FastAPI's 422 body, which is what a rejected message comes back as. */
export interface HttpValidationError {
  detail: ValidationErrorDto[];
}

/**
 * The backend sends its timestamps without a timezone designator, so `new Date()`
 * would read them as local time and put a conversation's activity hours early or
 * late depending on where the browser is. The values are UTC, and this appends the
 * designator.
 */
export function parseUtcTimestamp(value: string): string {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
}