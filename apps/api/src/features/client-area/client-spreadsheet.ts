/** One row of a client's spreadsheet: an advert on one of the station's days. */
export interface ClientSpreadsheetRow {
  stationDay: string;
  title: string;
  heard: number;
  calls: number;
  whatsApp: number;
  directions: number;
  website: number;
}

const HEADER = ['Day', 'Advert', 'Heard', 'Calls', 'WhatsApp', 'Directions', 'Website'];

/**
 * A text cell: always in quotes, inner quotes doubled, and a value a spreadsheet would run as a formula (one starting
 * with =, +, -, @, a tab or a carriage return) given a leading apostrophe, so it shows as text (P5C-EXPORT-01).
 */
export function spreadsheetText(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

/**
 * A client's figures as CSV (P5C-EXPORT-01): a header, then one line per advert per station day, with the advert's title
 * as text and the counts as numbers. Lines end with CRLF, as spreadsheets expect, and the file starts with a byte-order
 * mark so a spreadsheet reads the titles as UTF-8.
 */
export function clientSpreadsheet(rows: readonly ClientSpreadsheetRow[]): string {
  const lines = [
    HEADER.map(spreadsheetText).join(','),
    ...rows.map((row) =>
      [spreadsheetText(row.stationDay), spreadsheetText(row.title), row.heard, row.calls, row.whatsApp, row.directions, row.website].join(','),
    ),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** A file name a phone and a computer both accept: letters, digits and hyphens only. */
export function spreadsheetFileName(stationName: string | null, lastDay: string): string {
  const station = (stationName ?? 'station')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);
  return `look-up-${station || 'station'}-${lastDay}.csv`;
}
