import { toDateBucket } from './format-date.util';

describe('toDateBucket', () => {
  const now = new Date('2026-09-29T12:00:00.000Z').getTime();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const dayMs = 86_400_000;

  it('calls anything from the last week recent', () => {
    expect(toDateBucket(new Date(now).toISOString(), now)).toBe('Recent');
    expect(toDateBucket(ago(3 * dayMs), now)).toBe('Recent');
    expect(toDateBucket(ago(6 * dayMs + 23 * 3_600_000), now)).toBe('Recent');
  });

  it('calls everything else old', () => {
    expect(toDateBucket(ago(7 * dayMs), now)).toBe('Old');
    expect(toDateBucket(ago(20 * dayMs), now)).toBe('Old');
    expect(toDateBucket(ago(400 * dayMs), now)).toBe('Old');
  });
});
