import type { IconName } from '../../shared/components/icon/icon.component';

/**
 * One event on the administrator's recent-activity list.
 *
 * The shape is the same wherever an event came from, because the list merges
 * sources: an administrator reads it as one chronology, and a row that carried
 * its own source's vocabulary would have to be read differently from its
 * neighbours.
 */
export interface ActivityItem {
  id: string;
  /** Who the event is about. */
  actor: string;
  /** What happened, written as a continuation of the actor's name. */
  summary: string;
  /** ISO timestamp. */
  createdAt: string;
  icon: IconName;
}

/** The most recent event of any source, newest first. */
export const ACTIVITY_LIMIT = 8;