import type { SourceReference } from './message.model';

/** How the assistant resolved an asked question. */
export type QuestionOutcome = 'answered' | 'not-found' | 'failed';

/** One question asked against the knowledge base, kept for review. */
export interface QuestionLog {
  id: string;
  question: string;
  askedBy: string;
  askedByInitials: string;
  createdAt: string;
  outcome: QuestionOutcome;
  /**
   * What the asker was shown, or null when nothing was.
   *
   * Null is not a missing value to paper over: it is the whole reason a
   * `not-found` or `failed` entry is worth reading. An administrator reviewing a
   * log needs to see that the asker got an explanation rather than silence, and
   * `failed` is different from `not-found` precisely because no answer was ever
   * produced.
   */
  answer: string | null;
  /**
   * The passages retrieval considered, whether or not they were cited.
   *
   * A `not-found` entry keeps the near-misses: an empty list says only that
   * nothing scored high enough, while a short list of weak matches says which
   * document was close and therefore what is missing from the corpus.
   */
  sources: SourceReference[];
  durationMs: number;
}

/** Human-readable labels for each outcome. */
export const QUESTION_OUTCOME_LABELS: Record<QuestionOutcome, string> = {
  answered: 'Answered',
  'not-found': 'Not found',
  failed: 'Failed',
};
