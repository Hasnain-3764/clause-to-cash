// Find a rule's quote in the contract text. Pages are marked "=== Page N ===".
// Matching ignores differences in whitespace and curly vs straight quotes only;
// the words themselves must be verbatim.

const PAGE_MARK = /^=== Page (\d+) ===$/gm;

export function normalize(s: string): string {
  return s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export interface PageText {
  page: number;
  text: string;
  start: number; // offset of the page body in the raw contract text
}

export function splitPages(contract: string): PageText[] {
  const marks = [...contract.matchAll(PAGE_MARK)];
  if (marks.length === 0) return [{ page: 1, text: contract, start: 0 }];
  return marks.map((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index! : contract.length;
    return { page: Number(m[1]), text: contract.slice(start, end), start };
  });
}

/** Page number where the quote appears verbatim (whitespace-insensitive), or null. */
export function findQuotePage(contract: string, quote: string): number | null {
  const q = normalize(quote);
  if (!q) return null;
  for (const p of splitPages(contract)) if (normalize(p.text).includes(q)) return p.page;
  return null;
}

/**
 * Character range [start, end) of the quote in the raw contract text, for highlighting.
 * Builds a whitespace-tolerant regex from the quote's words.
 */
export function findQuoteRange(contract: string, quote: string): [number, number] | null {
  const words = normalize(quote).split(" ").filter(Boolean);
  if (!words.length) return null;
  const esc = (w: string) =>
    w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['\u2018\u2019]").replace(/"/g, '["\u201C\u201D]').replace(/-/g, "[-\u2013\u2014]");
  const re = new RegExp(words.map(esc).join("\\s+"));
  const m = re.exec(contract);
  return m ? [m.index, m.index + m[0].length] : null;
}
