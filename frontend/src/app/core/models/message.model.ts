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
 *
 * `greeting`, `restricted` and `out-of-scope` are answers that cite nothing for
 * reasons that have nothing to do with the corpus: one is small talk answered
 * without retrieving, one is a question turned away before retrieval was attempted,
 * and one was never in scope to answer. None is a failed search, and all three
 * would be misleading drawn as one — a refusal labelled "not found in company
 * documents" claims the gap is in the documents.
 *
 * `out-of-scope` is kept apart from `not-found` because the two mean opposite
 * things. `not-found` is "this is in scope and the documents do not cover it";
 * `out-of-scope` is "this was never something this assistant answers". Sending
 * somebody to HR over a general-knowledge question is not a useful answer, and it
 * reads as though the assistant had misunderstood the question.
 */
export type AnswerStatus =
  | 'pending'
  | 'answered'
  | 'not-found'
  | 'greeting'
  | 'restricted'
  | 'out-of-scope'
  | 'failed';

/**
 * The statuses a stored or streamed answer can arrive as.
 *
 * Separate from the type because the wire carries a plain string, and a status the
 * backend invents later has to be recognised as unknown rather than cast through
 * unchecked. `pending` and `failed` are absent on purpose: both belong to an answer
 * being produced here, so neither can arrive from the backend.
 */
export const INCOMING_ANSWER_STATUSES: readonly AnswerStatus[] = [
  'answered',
  'not-found',
  'greeting',
  'restricted',
  'out-of-scope',
];

/**
 * Narrows a wire status to a known one, or null when it is not one.
 *
 * The wire spells statuses in `kebab-case`, which is also how they are declared
 * above, so this is a set lookup with no translation. An unknown status returns
 * null rather than being cast through: a deployment that adds one should render as
 * an ordinary answer rather than as a failed search, which is the safer of the two
 * wrong readings.
 */
export function toKnownAnswerStatus(value: string | null | undefined): AnswerStatus | null {
  return value && INCOMING_ANSWER_STATUSES.includes(value as AnswerStatus)
    ? (value as AnswerStatus)
    : null;
}

/**
 * The outcome of one completed question, as a message is written with it.
 *
 * `status` is whatever the backend settled on rather than being worked out from
 * `answered`, because the backend distinguishes a greeting, a confidentiality
 * refusal and a genuine gap in the corpus — three answers that all cite nothing,
 * and three different things to show somebody.
 */
export interface ResolvedAnswer {
  text: string;
  status: AnswerStatus;
  sources: SourceReference[];
  confidence: number | null;
}

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
  /**
   * How well the retrieved passages matched the question, 1-10, or null when the
   * answer was not built from any.
   *
   * Null rather than zero for a greeting, a refusal or a gap in the corpus: those
   * have no passages to be confident about, and a low number beside them would read
   * as a poor answer rather than as the absence of one.
   */
  confidence: number | null;
}

/**
 * The shortest question the backend will accept, mirrored from its own bounds.
 *
 * Held here so the editor refuses to save something the server would reject, which
 * is the whole point of correcting a question in place: the round trip is for the
 * answer, not for a validation error.
 */
export const MIN_MESSAGE_LENGTH = 3;

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
