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
 * What kind of reply a message is, which is what decides how it is drawn.
 *
 * The backend names these, and every one of them except `answer` arrives with no
 * sources and no confidence, so they cannot be told apart from the absence of
 * either — which is exactly why they are named:
 *
 * - `answer`: a grounded answer, with the passages it came from.
 * - `not_found`: an in-scope question the documents do not cover. The only kind
 *   drawn as "not found in company documents", and the only one that names a route
 *   to HR, because it is the only one claiming a gap in the corpus.
 * - `out_of_scope`: a real request that was never something this assistant
 *   answers. Drawn as an ordinary reply, with no claim about the documents.
 * - `conversational`: a greeting, an acknowledgement, a remark about the exchange,
 *   or a question about the assistant. Drawn as an ordinary reply.
 * - `restricted`: a refusal, drawn as one.
 *
 * `pending` and `failed` are the two that never arrive from the backend: they
 * belong to an answer being produced here, or to a request that never produced
 * one. `failed` is kept apart from `not_found` because a dropped connection means
 * the answer may well exist, and telling somebody the documents do not cover it is
 * blaming the corpus for a network.
 */
export type AnswerKind =
  | 'pending'
  | 'failed'
  | 'answer'
  | 'not_found'
  | 'out_of_scope'
  | 'conversational'
  | 'restricted';

/**
 * The kinds a stored or streamed answer can arrive as.
 *
 * Separate from the type because the wire carries a plain string, and a kind the
 * backend invents later has to be recognised as unknown rather than cast through
 * unchecked. `pending` and `failed` are absent on purpose: both belong to an answer
 * being produced here, so neither can arrive from the backend.
 */
export const INCOMING_ANSWER_KINDS: readonly AnswerKind[] = [
  'answer',
  'not_found',
  'out_of_scope',
  'conversational',
  'restricted',
];

/**
 * The vocabulary the backend used before `kind` existed, mapped onto these.
 *
 * Read rather than dropped, so a message stored by an older deployment — a thread
 * reopened after an upgrade, or a response served by a backend that has not been
 * redeployed — still draws as what it was instead of falling back to "not found",
 * which is the one frame that is a claim about the corpus.
 */
const LEGACY_ANSWER_KINDS: Readonly<Record<string, AnswerKind>> = {
  answered: 'answer',
  'not-found': 'not_found',
  greeting: 'conversational',
  'out-of-scope': 'out_of_scope',
  restricted: 'restricted',
};

/**
 * Narrows a wire kind to a known one, or null when it is not one.
 *
 * Both vocabularies are accepted, because a deployment can be at either one for a
 * while: the stored rows behind this are written once and read for ever. An
 * unknown value returns null rather than being cast through, so a kind this app has
 * never heard of renders as an ordinary reply rather than as a failed search,
 * which is the safer of the two wrong readings.
 */
export function toKnownAnswerKind(value: string | null | undefined): AnswerKind | null {
  if (!value) {
    return null;
  }

  if (INCOMING_ANSWER_KINDS.includes(value as AnswerKind)) {
    return value as AnswerKind;
  }

  return LEGACY_ANSWER_KINDS[value] ?? null;
}

/**
 * The outcome of one completed question, as a message is written with it.
 *
 * `kind` is whatever the backend settled on rather than being worked out from
 * whether the answer cites anything, because the backend distinguishes a greeting,
 * a confidentiality refusal and a genuine gap in the corpus — three replies that
 * all cite nothing, and three different things to show somebody.
 */
export interface ResolvedAnswer {
  text: string;
  kind: AnswerKind;
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
  /** What kind of reply this is, which is what the thread draws it as. */
  kind: AnswerKind;
  /** Populated for an answered message; empty for a question and for a failure. */
  sources: SourceReference[];
  /** Set when the message is grounded, used for the "Grounded in N documents" hint. */
  documentCount: number;
  /**
   * How well the retrieved passages matched the question, 1-10, or null when the
   * answer was not built from any.
   *
   * Null rather than zero for a conversational reply, a refusal, an out-of-scope
   * reply or a gap in the corpus: those have no passages to be confident about, and
   * a low number beside them would read as a poor answer rather than as the absence
   * of one.
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