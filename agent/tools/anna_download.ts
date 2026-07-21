import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  annaDownloadDir,
  annaGetJson,
  buildIntelligibleName,
  downloadMd5ToArchive,
  formatBytes,
  normalizeMd5,
  summarizeRecord,
} from "../lib/anna.js";

/**
 * Member API → stream file into ~/archive with a human-readable name.
 */
export default defineTool({
  description:
    "Download one Anna's Archive file by MD5 into the local archive directory " +
    "using the member JSON API + ANNA_API_KEY. Saves under ANNA_DOWNLOAD_DIR " +
    "(default ~/archive) with an intelligible name like " +
    '"Title - Author (Year).epub". Prefer after anna_search. Never echo the key.',
  inputSchema: z.object({
    md5: z
      .string()
      .min(1)
      .describe("32-char MD5, md5:… prefix, or AA /md5/… URL."),
    filename: z
      .string()
      .optional()
      .describe(
        "Optional explicit basename. Default: intelligent Title - Author (Year).ext " +
          "from AA metadata / download URL.",
      ),
    path_index: z.number().int().min(0).optional(),
    domain_index: z.number().int().min(0).optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    md5: z.string(),
    path: z.string().nullable(),
    filename: z.string().nullable(),
    bytes: z.number().nullable(),
    bytes_human: z.string().nullable(),
    archive_dir: z.string(),
    title: z.string().nullable(),
    author: z.string().nullable(),
    error: z.string().nullable(),
    note: z.string(),
  }),
  async execute({ md5: raw, filename, path_index, domain_index }) {
    const md5 = normalizeMd5(raw);
    const archive_dir = annaDownloadDir();

    let extension: string | undefined;
    let title: string | null = null;
    let author: string | null = null;
    let year: string | null = null;

    try {
      const { status, data } = await annaGetJson<Record<string, unknown>>(
        `/db/aarecord_elasticsearch/md5:${md5}.json`,
        {},
        20_000,
      );
      if (status === 200 && data) {
        const summary = summarizeRecord(md5, data);
        title = summary.title;
        author = summary.author;
        year = summary.year;
        if (summary.extension) extension = summary.extension;
      }
    } catch {
      /* optional — URL parsing still helps */
    }

    // If no explicit filename, always try intelligible Title - Author (Year).ext
    if (!filename && title) {
      filename = buildIntelligibleName({
        title,
        author,
        year,
        extension: extension ?? "bin",
      });
    }

    const result = await downloadMd5ToArchive(md5, {
      path_index,
      domain_index,
      filename,
      title,
      author,
      year,
      extension,
      timeoutMs: 600_000,
    });

    return {
      ok: result.ok,
      md5,
      path: result.path,
      filename: result.filename,
      bytes: result.bytes,
      bytes_human: result.bytes != null ? formatBytes(result.bytes) : null,
      archive_dir,
      title,
      author,
      error: result.error,
      note: result.ok
        ? `Saved with intelligible name under ${archive_dir}.`
        : `Download failed. archive_dir=${archive_dir}`,
    };
  },
  toModelOutput(output) {
    if (output.ok && output.path) {
      return {
        type: "text" as const,
        value:
          `Saved ${output.filename ?? output.title ?? output.md5} → ${output.path}` +
          (output.bytes_human ? ` (${output.bytes_human})` : ""),
      };
    }
    return {
      type: "text" as const,
      value: `anna_download failed for ${output.md5}: ${output.error ?? "unknown"}`,
    };
  },
});
