import { defineTool } from "eve/tools";
import { z } from "zod";
import { annaGetJson, normalizeMd5, summarizeRecord } from "../lib/anna.js";

export default defineTool({
  description:
    "Look up one Anna's Archive file by MD5 hash only. Returns unified title, " +
    "author, year, size, languages, identifiers, torrent/download flags. " +
    "Requires a known md5 (AA /md5/<hash> URL or dump). NOT title/ISBN " +
    "search — AA has no public search API; do not scrape /search. For ISBN " +
    "bibliography use openlibrary_isbn; for offline AA search use " +
    "anna_torrents aa_derived_mirror_metadata (skill anna / llms.txt).",
  inputSchema: z.object({
    md5: z
      .string()
      .min(1)
      .describe(
        "32-char MD5 hex, optional md5: prefix, or an AA /md5/… URL/path.",
      ),
  }),
  outputSchema: z.object({
    md5: z.string(),
    id: z.string(),
    title: z.string().nullable(),
    author: z.string().nullable(),
    year: z.string().nullable(),
    publisher: z.string().nullable(),
    extension: z.string().nullable(),
    filesize: z.number().nullable(),
    filesize_human: z.string().nullable(),
    language_codes: z.array(z.string()),
    content_type: z.string().nullable(),
    cover_url: z.string().nullable(),
    description: z.string().nullable(),
    identifiers: z.record(z.string(), z.array(z.string())).nullable(),
    has_torrent_paths: z.boolean().nullable(),
    torrent_paths: z.array(z.unknown()).nullable(),
    has_aa_downloads: z.boolean().nullable(),
    page_url: z.string(),
    record_json_url: z.string(),
    note: z.string(),
  }),
  async execute({ md5: raw }) {
    const md5 = normalizeMd5(raw);
    const path = `/db/aarecord_elasticsearch/md5:${md5}.json`;
    const { status, data } = await annaGetJson<Record<string, unknown>>(
      path,
      {},
      30_000,
    );

    if (status === 404) {
      throw new Error(`No Anna's Archive record for md5 ${md5}`);
    }
    if (status !== 200) {
      const err =
        typeof data?.error === "string" ? data.error : `HTTP ${status}`;
      throw new Error(`Record lookup failed for ${md5}: ${err}`);
    }

    // Empty / missing unified data often means not found-style payload
    if (!data || typeof data !== "object" || !("file_unified_data" in data)) {
      throw new Error(
        `Unexpected record payload for md5 ${md5} (status ${status})`,
      );
    }

    const summary = summarizeRecord(md5, data);
    return {
      ...summary,
      note:
        "Per-file JSON is convenient but AA prefers local mirrors of " +
        "aa_derived_mirror_metadata for heavy use. Member fast download: " +
        "anna_fast_download with ANNA_API_KEY. See skill anna.",
    };
  },
  toModelOutput(output) {
    const bits = [
      output.title ?? "(no title)",
      output.author,
      output.year,
      output.extension,
      output.filesize_human,
      output.language_codes.length
        ? `lang=${output.language_codes.join(",")}`
        : null,
    ].filter(Boolean);
    return {
      type: "text" as const,
      value: `AA ${output.md5}: ${bits.join(" · ")} · ${output.page_url}`,
    };
  },
});
