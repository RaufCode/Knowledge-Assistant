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
 * Two words. It sits inside a field that is already the widest thing on the screen
 * and already has a send button beside it, so a sentence describing what the
 * assistant knows is redundant with the answer it gives. Anything longer than this
 * is read rather than glanced at, and it is gone the moment the field is touched.
 */
export const QUESTION_PLACEHOLDER = 'Ask anything';

/**
 * Starter prompts on the dashboard. Product copy rather than data: the backend has
 * no endpoint for them, and inventing one would mean guessing at a contract it does
 * not have.
 *
 * Two of them, and two words each. A row of suggestions is a decision aid, so the
 * smaller it is the more it reads as a choice rather than as a menu to browse, and a
 * two-word topic is enough to recognise what the assistant knows about. The full
 * question is typed into the composer, which is one field away and remembers it.
 */
export const STARTER_QUESTIONS: readonly string[] = ['Annual leave', 'VPN setup'];

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
