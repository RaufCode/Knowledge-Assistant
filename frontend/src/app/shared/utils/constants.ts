/**
 * Limits the composer enforces, matching the backend's own bounds on
 * `ChatRequest.question`. Agreeing with the server here is what keeps a
 * rejected question from ever leaving the browser: the API answers anything
 * shorter than three or longer than 500 characters with a 422.
 */
export const MIN_QUESTION_LENGTH = 3;
export const MAX_QUESTION_LENGTH = 500;

/**
 * Placeholder shown in the composer when it is empty.
 *
 * "Ask anything" promised more than the assistant delivers. It answers from a fixed
 * set of internal documents, and says plainly when a question is not in them, so the
 * prompt names that instead of implying every question is answerable — which is the
 * difference between knowing what to ask and finding out by being refused.
 *
 * Short for the width it has to live in, and measured rather than guessed: the
 * composer is a full-width field with a send button beside it, which on a 280px
 * screen leaves about 170px of usable text. "Ask about company policies" measured
 * wider than that and clipped, and a placeholder cut off mid-word is worse than a
 * vague one. This one fits at every width from there up.
 */
export const QUESTION_PLACEHOLDER = 'Ask about our policies';

/**
 * Starter prompts on the dashboard. Product copy rather than data: the backend has
 * no endpoint for them, and inventing one would mean guessing at a contract it does
 * not have.
 *
 * Two of them, and both written as the question that is actually asked. Choosing one
 * sends it to the assistant as the question verbatim, so a two-word topic was not a
 * shortcut on the way to asking it — it was the question, and the assistant was
 * handed a bare noun to answer. The button also said what it would do: pressing it
 * asks something, and this now reads as the thing being asked rather than as a
 * chapter of a handbook.
 *
 * Both are answerable from the documents that are actually loaded, so neither
 * suggestion leads to a "no answer found" on the first press.
 */
export const STARTER_QUESTIONS: readonly string[] = [
  'How many annual leave days do I get?',
  'How do I set up the VPN on a new laptop?',
];

/** Key used to remember the desktop sidebar preference. */
export const SIDEBAR_PREFERENCE_KEY = 'ika.sidebar.collapsed';

/** Viewport width, in px, at which the sidebar becomes a persistent column. */
export const DESKTOP_BREAKPOINT = 1024;

/**
 * Viewport the shell assumes when there is no window to measure, which is every
 * server render and the first paint before hydration.
 *
 * Compact is the deliberate guess: the `lg` media query promotes the drawer
 * shell to the column layout on a wide screen anyway, so guessing compact
 * paints a phone correctly and costs a desktop nothing. Guessing desktop left
 * phones opening with the sidebar dropped on top of the page.
 */
export const INITIAL_VIEWPORT_WIDTH = 0;

/** Milliseconds the copied answer stays labelled as copied. */
export const COPY_FEEDBACK_MS = 1600;
