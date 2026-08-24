import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});

/**
 * Convert TipTap editor HTML to markdown, preserving <table> elements as
 * markdown pipe tables.
 *
 * Tables are replaced with unique markers before Turndown runs, then swapped
 * back after — this avoids Turndown collapsing newlines or escaping pipe
 * characters.
 *
 * Extracted from RichTextEditor so every consumer of the shared editor (the
 * chat prompt input, the notes panel, and the AskUserQuestion dialog) turns
 * the same editor HTML into identical markdown.
 *
 * Browser-only: relies on the DOM (`document`). Do NOT import from node-only
 * code (e.g. the vitest serializer suite).
 */
export function htmlToMarkdown(rawHtml: string): string {
  const div = document.createElement('div');
  div.innerHTML = rawHtml;
  const tableMdMap = new Map<string, string>();
  div.querySelectorAll('table').forEach((table, idx) => {
    const rows = table.querySelectorAll('tr');
    const mdRows: string[] = [];

    rows.forEach((row, i) => {
      const cells = row.querySelectorAll('th, td');
      const values = Array.from(cells).map(cell => (cell.textContent || '').trim());
      mdRows.push('| ' + values.join(' | ') + ' |');
      if (i === 0) {
        mdRows.push('| ' + values.map(() => '---').join(' | ') + ' |');
      }
    });

    const marker = `FURYTABLE${idx}FURYTABLE`;
    tableMdMap.set(marker, mdRows.join('\n'));
    const placeholder = document.createElement('p');
    placeholder.textContent = marker;
    table.replaceWith(placeholder);
  });

  let markdown = turndown.turndown(div.innerHTML).trim();

  // Swap markers back with the raw table markdown
  for (const [marker, md] of tableMdMap) {
    markdown = markdown.replace(marker, md);
  }

  return markdown;
}
