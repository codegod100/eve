import { defineTool } from "eve/tools";
import { z } from "zod";
import { annasArticleSearch } from "../lib/annas-mcp.js";

export default defineTool({
  description:
    "Search Anna's Archive for papers/articles by DOI or keywords via " +
    "annas-mcp CLI (unofficial). Returns hits with MD5 when available. " +
    "For books/ISBN use anna_search instead. Requires annas-mcp installed.",
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .describe("DOI (e.g. 10.1038/…) or article keywords."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .default(10)
      .describe("Max hits (default 10)."),
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
    const result = await annasArticleSearch(query, {
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
        "Unofficial annas-mcp article search. Use md5 with anna_record / " +
        "anna_fast_download (ANNA_API_KEY).",
    };
  },
  toModelOutput(output) {
    if (!output.ok || output.count === 0) {
      return {
        type: "text" as const,
        value: `anna_article_search "${output.query}": no hits (${output.error ?? "empty"}).`,
      };
    }
    const lines = output.hits.slice(0, 6).map((h) =>
      [h.md5 ?? "?", h.title, h.format].filter(Boolean).join(" · "),
    );
    return {
      type: "text" as const,
      value: `anna_article_search: ${output.count} hits. ${lines.join(" | ")}`,
    };
  },
});
