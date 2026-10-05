/**
 * A file size as a person would read it, rather than in bytes.
 *
 * One implementation, because a size shown in the upload panel and the same size
 * shown in the inventory row have to agree. Two copies drift: the one written
 * first rounded anything under a kilobyte to "0 KB", which reads as an empty file.
 *
 * The KB step rounds to whole numbers, matching how browsers and operating systems
 * report a small file, and the MB step keeps one decimal so a column of sizes stays
 * comparable at a glance.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 KB';
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
