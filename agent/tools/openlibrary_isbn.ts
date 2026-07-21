import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Bibliographic ISBN lookup via Open Library (not Anna's Archive).
 * Use for title/author confirmation when users ask "find book by ISBN"
 * before explaining AA has no public search API.
 */

function normalizeIsbn(raw: string): string {
  const s = raw.trim().replace(/[-\s]/g, "").toUpperCase();
  if (!/^\d{9}[\dX]$|^\d{13}$/.test(s)) {
    throw new Error(
      `Invalid ISBN "${raw}": expected ISBN-10 or ISBN-13 (digits, optional hyphens)`,
    );
  }
  return s;
}

function isbn10to13(isbn10: string): string {
  if (isbn10.length === 13) return isbn10;
  const core = `978${isbn10.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return `${core}${check}`;
}

export default defineTool({
  description:
    "Look up bibliographic metadata for an ISBN via Open Library (title, " +
    "author, year, pages, publisher, subjects). Use when the user gives an " +
    "ISBN or asks what book an ISBN is — including before Anna's Archive " +
    "workflows. This is NOT AA search/download: AA has no public search API " +
    "and must not be CAPTCHA-scraped (see skill anna / llms.txt).",
  inputSchema: z.object({
    isbn: z
      .string()
      .min(1)
      .describe("ISBN-10 or ISBN-13, with or without hyphens."),
  }),
  outputSchema: z.object({
    isbn: z.string(),
    isbn13: z.string().nullable(),
    found: z.boolean(),
    title: z.string().nullable(),
    subtitle: z.string().nullable(),
    authors: z.array(z.string()),
    publish_date: z.string().nullable(),
    publishers: z.array(z.string()),
    number_of_pages: z.number().nullable(),
    subjects: z.array(z.string()),
    openlibrary_url: z.string().nullable(),
    identifiers: z.record(z.string(), z.array(z.string())).nullable(),
    note: z.string(),
  }),
  async execute({ isbn: raw }) {
    const isbn = normalizeIsbn(raw);
    const isbn13 = isbn.length === 10 ? isbn10to13(isbn) : isbn;
    const key = `ISBN:${isbn13}`;
    const url = new URL("https://openlibrary.org/api/books");
    url.searchParams.set("bibkeys", key);
    url.searchParams.set("format", "json");
    url.searchParams.set("jscmd", "data");

    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent":
          "eve-agent/openlibrary-isbn (+https://openlibrary.org/dev/docs/api/books)",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(`Open Library books API failed (${res.status})`);
    }

    const data = (await res.json()) as Record<
      string,
      {
        title?: string;
        subtitle?: string;
        authors?: { name?: string }[];
        publish_date?: string;
        publishers?: { name?: string }[];
        number_of_pages?: number;
        subjects?: { name?: string }[];
        url?: string;
        identifiers?: Record<string, string[]>;
      }
    >;

    const rec = data[key] ?? data[`ISBN:${isbn}`] ?? null;
    if (!rec) {
      return {
        isbn,
        isbn13,
        found: false,
        title: null,
        subtitle: null,
        authors: [],
        publish_date: null,
        publishers: [],
        number_of_pages: null,
        subjects: [],
        openlibrary_url: null,
        identifiers: null,
        note:
          "No Open Library hit for this ISBN. For Anna's Archive file search: " +
          "no public search API (llms.txt) — human browser search or " +
          "aa_derived_mirror_metadata offline; never CAPTCHA-scrape AA.",
      };
    }

    return {
      isbn,
      isbn13,
      found: true,
      title: rec.title ?? null,
      subtitle: rec.subtitle ?? null,
      authors: (rec.authors ?? [])
        .map((a) => a.name)
        .filter((n): n is string => typeof n === "string" && n.length > 0),
      publish_date: rec.publish_date ?? null,
      publishers: (rec.publishers ?? [])
        .map((p) => p.name)
        .filter((n): n is string => typeof n === "string" && n.length > 0),
      number_of_pages:
        typeof rec.number_of_pages === "number" ? rec.number_of_pages : null,
      subjects: (rec.subjects ?? [])
        .map((s) => s.name)
        .filter((n): n is string => typeof n === "string" && n.length > 0)
        .slice(0, 12),
      openlibrary_url: rec.url ?? null,
      identifiers: rec.identifiers ?? null,
      note:
        "Bibliography only (Open Library). Per AA llms.txt, robots do not " +
        "scrape /search — they use anna_torrents aa_derived_mirror_metadata " +
        "for offline ISBN→md5 search, then anna_record / member " +
        "anna_fast_download. Always call anna_torrents next for AA intent.",
    };
  },
  toModelOutput(output) {
    if (!output.found) {
      return {
        type: "text" as const,
        value: `Open Library: no record for ISBN ${output.isbn}. ${output.note}`,
      };
    }
    const bits = [
      output.title,
      output.authors.join(", ") || null,
      output.publish_date,
      output.number_of_pages != null ? `${output.number_of_pages}p` : null,
      output.publishers[0] ?? null,
      `ISBN ${output.isbn13 ?? output.isbn}`,
    ].filter(Boolean);
    return {
      type: "text" as const,
      value:
        `OL: ${bits.join(" · ")}. Next for AA: anna_torrents ` +
        `aa_derived_mirror_metadata (llms.txt bulk path), then md5 tools.`,
    };
  },
});
