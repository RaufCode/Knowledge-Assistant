import { Message } from './message.model';

/**
 * A conversation as this browser's own list of them holds it.
 *
 * One of these is one row in the sidebar, however many questions have been asked
 * in it. That is the whole point of the model: follow-ups extend the conversation
 * they belong to rather than each adding an entry, so a user reading back through
 * their own work sees whole threads.
 */
export interface Conversation {
  id: string;
  /**
   * The conversation's name, or null while it has none.
   *
   * Null is a real state, not a gap in the data: a conversation starts unnamed and
   * is named once its first exchange has been answered, so the list can show a
   * conversation the user has just opened but not yet asked anything in.
   */
  title: string | null;
  /**
   * When the conversation was last active, and what the list is ordered by.
   *
   * Asking a follow-up moves the conversation up the list, which is what "recent"
   * means once conversations are long-lived: not when they were started, but when
   * they were last used.
   */
  updatedAt: string;
}

/** Shown in the sidebar and the conversations list for a conversation with no name. */
export const UNTITLED_CONVERSATION = 'New conversation';

/**
 * One conversation with its thread loaded.
 *
 * Separate from `Conversation` because the list endpoint does not return messages
 * and the detail endpoint does not return an activity timestamp: which of the two
 * a caller holds is exactly what it has been told, so neither shape claims a field
 * it was not given.
 */
export interface ConversationThread {
  id: string;
  title: string | null;
  /** Every message, oldest first, as the thread renders them. */
  messages: Message[];
}
