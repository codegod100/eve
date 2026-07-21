import { defineTool } from "eve/tools";
import { z } from "zod";
import { annasBookSearch } from "../lib/annas-mcp.js";

export default defineTool({
  description:
    "Search Anna's Archive for books by title, author, ISBN, or topic via " +
    "the annas-mcp CLI (unofficial). Returns title, format, size, URL, and " +
    "**MD5 hash** for each hit — use those MD5s with anna_record / " +
    "anna_fast_download. Prefer this for single-book ISBN/title lookup " +
    "instead of the 1.5TB metadata torrent. Requires annas-mcp on PATH " +
    "(or ANNAS_MCP_BIN / ~/.local/bin/annas-mcp). See skill anna.",
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        "Search query: ISBN (e.g. 9780374176815), title, author, or keywords.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .default(10)
      .describe("Max hits to return (default 10)."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    query: z.string(),
    count: z.number(),
    hits: z.array(
      z.object({
        index: z.number(),
        title: z.string().nullable(),
        authors: z.string().nullable(),
        publisher: z.string().nullable(),
        language: z.string().nullable(),
        format: z.string().nullable(),
        size: z.string().nullable(),
        url: z.string().nullable(),
        md5: z.string().nullable(),
      }),
    ),
    bin: z.string(),
    error: z.string().optional(),
    note: z.string(),
  }),
  async execute({ query, limit }) {
    const result = await annasBookSearch(query, {
      limit: limit ?? 10,
      timeoutMs: 90_000,
    });
    return {
      ok: result.ok,
      query,
      count: result.hits.length,
      hits: result.hits,
      bin: result.bin,
      error: result.error,
      note:
        "Unofficial annas-mcp search (not AA official search API). " +
        "Pick an md5 → anna_record for unified metadata; " +
        "anna_fast_download with ANNA_API_KEY for member URL. " +
        "llms.txt still prefers bulk dumps for heavy indexing.",
    };
  },
  toModelOutput(output) {
    if (!output.ok || output.count === 0) {
      return {
        type: "text" as const,
        value: `anna_search "${output.query}": no hits (${output.error ?? "empty"}). ${output.note}`,
      };
    }
    const lines = output.hits.slice(0, 8).map((h) => {
      const bits = [
        h.md5 ?? "?",
        h.format,
        h.size,
        h.title,
        h.authors,
      ].filter(Boolean);
      return bits.join(" · ");
    });
    return {
      type: "text" as const,
      value: `anna_search "${output.query}": ${output.count} hits. ${lines.join(" | ")}`,
    };
  },
});
