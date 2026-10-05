/**
 * Markdown to HTML, for the assistant's answers.
 *
 * The backend answers in markdown: bold labels, bullet lists, numbered steps and
 * occasional tables. Bound as plain text those markers leak into the UI as
 * literal asterisks and pipes, so answers are converted here instead.
 *
 * Every character of the source is HTML-escaped before any tag is emitted, so
 * the only markup in the result is the markup written in this file. That makes
 * the output safe by construction, and Angular's own sanitizer still runs over
 * the bound string as a second pass.
 *
 * Scope is deliberately narrow: the subset the backend's prompt actually asks
 * for. Nested lists are flattened rather than mis-nested, since the prompt asks
 * for "numbered steps when the source describes a process" and the corpus does
 * not contain nested structures.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes the five characters that could otherwise open a tag or an attribute. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

/**
 * Inline emphasis and code, applied to already-escaped text.
 *
 * Code spans are lifted out first and put back afterwards, so emphasis markers
 * inside `code` stay literal. Applying bold in a single pass would otherwise
 * match the `**` sitting between the generated `<code>` tags and bold the
 * contents of the span.
 */
function renderInline(text: string): string {
  const spans: string[] = [];

  const withPlaceholders = escapeHtml(text).replace(/`([^`]+)`/g, (_match, code: string) => {
    spans.push(`<code>${code}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });

  const emphasised = withPlaceholders
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:!?])/g, '$1<em>$2</em>');

  return emphasised.replace(/\u0000(\d+)\u0000/g, (_match, at: string) => spans[Number(at)]);
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const UNORDERED_ITEM = /^\s*[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

function isTableRow(line: string | undefined): boolean {
  return typeof line === 'string' && line.trim().startsWith('|');
}

/** Splits `| a | b |` into its cells, dropping the empty edges. */
function toCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Consumes a heading-row plus its `|---|---|` divider and any body rows. */
function readTable(lines: string[], start: number, html: string[]): number {
  const header = toCells(lines[start]);
  let index = start + 2; // skip the divider row
  const rows: string[][] = [];

  while (isTableRow(lines[index])) {
    rows.push(toCells(lines[index]));
    index++;
  }

  const head = header.map((cell) => `<th>${renderInline(cell)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
    .join('');

  html.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
  return index;
}

/** Consumes one run of bullets or numbered items. */
function readList(lines: string[], start: number, html: string[], ordered: boolean): number {
  const pattern = ordered ? ORDERED_ITEM : UNORDERED_ITEM;
  const items: string[] = [];
  let index = start;

  while (index < lines.length) {
    const match = pattern.exec(lines[index]);

    if (!match) {
      break;
    }

    items.push(renderInline(match[1]));
    index++;
  }

  const tag = ordered ? 'ol' : 'ul';
  html.push(`<${tag}>${items.map((item) => `<li>${item}</li>`).join('')}</${tag}>`);
  return index;
}

/** True for a line that should interrupt a paragraph and start a new block. */
function startsBlock(line: string): boolean {
  return (
    !line.trim() ||
    HEADING.test(line) ||
    UNORDERED_ITEM.test(line) ||
    ORDERED_ITEM.test(line) ||
    isTableRow(line)
  );
}

/** Consumes wrapped paragraph lines, which markdown rejoins into one line. */
function readParagraph(lines: string[], start: number, html: string[]): number {
  const collected: string[] = [];
  let index = start;

  while (index < lines.length && !startsBlock(lines[index])) {
    collected.push(lines[index].trim());
    index++;
  }

  html.push(`<p>${renderInline(collected.join(' '))}</p>`);
  return index;
}

/** Strips the block markers that only mean something as layout in a full answer. */
const BLOCK_MARKER = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/;

/**
 * Converts a citation snippet to inline HTML.
 *
 * A snippet is a fragment of a policy page, so it arrives carrying that page's
 * structure: a `##` heading, bullet markers, table pipes. Block elements would
 * be wrong inside a two-line citation, and the markers themselves would be noise,
 * so structure is stripped while emphasis is kept. `## Annual leave` above
 * `Staff get **21 days**` becomes a single run reading
 * `Annual leave Staff get 21 days`, with both emphases rendered as emphasis.
 *
 * What the layout carried is rebuilt as weight rather than dropped: a heading
 * becomes bold, because it is the line naming the section the rest quotes, and
 * the first row of a table becomes bold, because without the grid it would be
 * indistinguishable from the data rows under it. Table rows keep their cells,
 * joined by a middot, so a contact directory still reads as pairs.
 */
export function markdownToSnippetHtml(markdown: string): string {
  const parts: string[] = [];
  let isTableHeader = true;

  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim() || TABLE_DIVIDER.test(line)) {
      continue;
    }

    if (isTableRow(line)) {
      const cells = toCells(line).map((cell) => (isTableHeader ? `**${cell}**` : cell));
      parts.push(cells.join(' · '));
      isTableHeader = false;
      continue;
    }

    const text = line.replace(BLOCK_MARKER, '').trim();
    parts.push(/^\s*#{1,6}\s/.test(line) ? `**${text}**` : text);
  }

  return renderInline(parts.join(' ').replace(/\s+/g, ' ').trim());
}

/** Converts an assistant answer from markdown to HTML. */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index++;
      continue;
    }

    if (isTableRow(line) && TABLE_DIVIDER.test(lines[index + 1] ?? '')) {
      index = readTable(lines, index, html);
      continue;
    }

    const heading = HEADING.exec(line);

    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      index++;
      continue;
    }

    if (UNORDERED_ITEM.test(line)) {
      index = readList(lines, index, html, false);
      continue;
    }

    if (ORDERED_ITEM.test(line)) {
      index = readList(lines, index, html, true);
      continue;
    }

    index = readParagraph(lines, index, html);
  }

  return html.join('');
}
