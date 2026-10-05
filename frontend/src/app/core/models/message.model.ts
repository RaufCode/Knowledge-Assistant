/**
 * A single citation backing an answer. Answers are grounded in documents, so the
 * sources travel with the message rather than being looked up separately.
 */
export interface SourceReference {
  /** Human readable document title, e.g. `Leave Policy`. */
  document: string;
  /** Section reference inside the document, e.g. `Section 4.2`. */
  section: string;
  /** The passage the answer was drawn from. */
  snippet: string;
  /**
   * Retrieval relevance, carried through from the backend. Never rendered as a
   * number: the API states no range or unit for it, so a percentage would be a
   * guess about a value nobody has defined.
   */
  score: number;
}

/**
 * Outcome of a single message.
 *
 * `failed` is a transport outcome rather than an answer outcome: the assistant
 * never got to answer. It is kept distinct from `not-found`, which is the
 * assistant reporting that the corpus genuinely has nothing, because the two
 * need different wording and different recovery.
 */
export type AnswerStatus = 'pending' | 'answered' | 'not-found' | 'failed';

/** Who produced a message. */
export type MessageRole = 'user' | 'assistant';

/** One message in a conversation thread. */
export interface Message {
  id: string;
  role: MessageRole;
  /**
   * Markdown from the backend, rendered as HTML by the answer card.
   *
   * Conversion escapes the text before emitting any tag, so an answer can carry
   * formatting without being able to carry markup of its own.
   */
  text: string;
  createdAt: string;
  status: AnswerStatus;
  /** Populated for an answered message; empty for a question and for a failure. */
  sources: SourceReference[];
  /** Set when the message is grounded, used for the "Grounded in N documents" hint. */
  documentCount: number;
}

/**
 * Counts the distinct documents a message's answer draws on.
 *
 * Derived wherever it is needed rather than carried on the message, so there is
 * one derivation of it rather than a number that can disagree with the list it was
 * counted from.
 */
export function countDocuments(sources: SourceReference[]): number {
  return new Set(sources.map((source) => source.document)).size;
}
