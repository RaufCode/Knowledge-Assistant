/** Words that carry no meaning in a topic, so initials skip them. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'how',
  'i',
  'in',
  'is',
  'my',
  'of',
  'should',
  'the',
  'to',
  'what',
  'when',
  'where',
  'who',
  'why',
  'will',
  'would',
]);

/**
 * Initials for a topic, used by the collapsed sidebar rail where there is no
 * room for a title. `Annual leave entitlement` becomes `AL`.
 */
export function toInitials(topic: string, maxWords = 2): string {
  const words = topic.split(/[\s-]+/).filter(Boolean);
  const significant = words.filter((word) => !STOP_WORDS.has(word.toLowerCase()));
  const chosen = (significant.length > 0 ? significant : words).slice(0, maxWords);

  if (chosen.length === 0) {
    return '?';
  }

  return chosen
    .map((word) => word.charAt(0).toUpperCase())
    .join('')
    .slice(0, maxWords);
}
