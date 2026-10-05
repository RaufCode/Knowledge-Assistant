/**
 * A timestamp as a reader would say it out loud: "just now", "12 minutes ago",
 * "3 days ago".
 *
 * A conversation list is ordered by when each one was last active, and an absolute
 * date makes a list sorted by recency read as if it were arbitrary. Anything older
 * than a week falls back to the date, at which point the difference between
 * "19 days ago" and "3 weeks ago" is not worth carrying.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function formatRelativeTime(isoDate: string, now: number = Date.now()): string {
  const elapsed = now - new Date(isoDate).getTime();

  // A timestamp from the future, which clock skew between the browser and the
  // backend can produce, is shown as "just now" rather than as a negative age.
  if (elapsed < MINUTE) {
    return 'just now';
  }

  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);

    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }

  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);

    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  if (elapsed < WEEK) {
    const days = Math.floor(elapsed / DAY);

    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  return formatAbsoluteDate(isoDate);
}

/**
 * A timestamp as a calendar date: "20 Sep 2026".
 *
 * Used where the exact day is the point rather than the age, such as when a
 * document was uploaded. A relative time would be wrong there: the inventory is
 * ordered by recency, and "3 days ago" on every row in a list sorted newest first
 * says less than the date does.
 */
export function formatAbsoluteDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
