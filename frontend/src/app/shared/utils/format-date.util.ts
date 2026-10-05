/** The only two headings the question lists use. */
export type DateBucket = 'Recent' | 'Old';

/** Anything asked within the last seven days counts as recent. */
const RECENT_LIMIT = 7 * 86_400_000;

/** Heading a question falls under: everything after `Recent` is `Old`. */
export function toDateBucket(isoDate: string, now: number = Date.now()): DateBucket {
  return now - new Date(isoDate).getTime() < RECENT_LIMIT ? 'Recent' : 'Old';
}

/** Truncates a string for use in a single-line list row. */
export function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength).trimEnd()}...`;
}
