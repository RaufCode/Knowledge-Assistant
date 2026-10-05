/**
 * Small talk, recognised locally so it never reaches retrieval.
 *
 * The backend answers every question from the indexed policies or not at all,
 * and it has no notion of a greeting: "hello" goes through retrieval like
 * anything else and comes back as a gap in the corpus. That reads as a confused
 * assistant rather than an honest one, so the check below answers the door
 * before anything is sent.
 *
 * Deliberately strict: only a message that *is* a greeting counts. Anything
 * carrying a question alongside the greeting ("hi, how many leave days?") is a
 * question and is sent, because answering that with small talk would be refusing
 * to do the actual job.
 */

/** A greeting on its own, after normalisation. */
const BARE_GREETINGS = new Set([
  'hi',
  'hii',
  'hello',
  'helloo',
  'hey',
  'heyy',
  'yo',
  'hiya',
  'howdy',
  'greetings',
  'good morning',
  'good afternoon',
  'good evening',
  'good day',
  'morning',
  'afternoon',
  'evening',
  'how are you',
  'how r u',
  'how are u',
  "how's it going",
  'hows it going',
  'how is it going',
  "what's up",
  'whats up',
  'what is up',
  'sup',
  'how do you do',
  'how do u do',
  'nice to meet you',
]);

/** Words that may follow a greeting without making it a question. */
const ADDRESSEES = new Set([
  'there',
  'assistant',
  'bot',
  'team',
  'everyone',
  'everybody',
  'folks',
  'friend',
  'friends',
  'all',
]);

/** Upper bound on a normalised greeting, so sentences never qualify. */
const MAX_GREETING_LENGTH = 32;

/**
 * Whether this message is small talk and nothing else.
 *
 * Case, surrounding whitespace and trailing punctuation are ignored, and
 * stretched letters are folded ("helloooo" counts as "helloo"), because none
 * of those change what the message is.
 */
export function isGreeting(text: string): boolean {
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, ' ')
    .replace(/(.)\1{2,}/g, '$1$1')
    .replace(/[!?.…,;:'"]+$/g, '')
    .trim();

  if (!cleaned || cleaned.length > MAX_GREETING_LENGTH) {
    return false;
  }

  if (BARE_GREETINGS.has(cleaned)) {
    return true;
  }

  // "hello there", "good morning team": a greeting plus somebody to greet.
  const lastSpace = cleaned.lastIndexOf(' ');

  if (lastSpace === -1) {
    return false;
  }

  return (
    BARE_GREETINGS.has(cleaned.slice(0, lastSpace)) &&
    ADDRESSEES.has(cleaned.slice(lastSpace + 1))
  );
}

/**
 * A warm reply, naming the time of day.
 *
 * Says what the assistant is for and what to ask it, because a greeting that
 * only says hello back leaves a first-time visitor facing an empty box with no
 * idea what it takes.
 */
export function greetingReply(now: Date = new Date()): string {
  const hour = now.getHours();
  const daypart = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

  return (
    `Good ${daypart}! I'm the Internal Knowledge Assistant for Acme Technologies. ` +
    `I answer from our company policies — ask me about leave, working hours, ` +
    `benefits, IT setup, or conduct, and I'll find the exact section for you.`
  );
}
