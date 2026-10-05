import { formatFileSize } from './file-size.util';

describe('formatFileSize', () => {
  it('reports small files in bytes rather than rounding them away', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(1)).toBe('1 B');
    expect(formatFileSize(512)).toBe('512 B');
  });

  it('rounds to whole kilobytes below a megabyte', () => {
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(860 * 1024)).toBe('860 KB');
  });

  it('keeps one decimal above a megabyte so a column stays comparable', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(2.4 * 1024 * 1024)).toBe('2.4 MB');
  });

  it('falls back to a readable size for a value that is not one', () => {
    expect(formatFileSize(-1)).toBe('0 KB');
    expect(formatFileSize(Number.NaN)).toBe('0 KB');
  });
});
