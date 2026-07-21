import { defineTool } from "eve/tools";
import { z } from "zod";
import { normalizeMd5, requestFastDownloadUrl } from "../lib/anna.js";

export default defineTool({
  description:
    "Get a member fast-download URL for one AA file by MD5 " +
    "(/dyn/api/fast_download.json). Uses OpenBao/env ANNA_API_KEY as the " +
    "JSON API secret (or optional key= from human). Does not save to disk — " +
    "use anna_download to write into ~/archive. Never invent or echo keys.",
  inputSchema: z.object({
    md5: z
      .string()
      .min(1)
      .describe("32-char MD5 of the file (or md5:… / AA URL)."),
    key: z
      .string()
      .optional()
      .describe(
        "Override membership secret. Prefer env ANNA_API_KEY from OpenBao; " +
          "only pass when the human explicitly provided a key this turn.",
      ),
    path_index: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Collection index when the file appears in multiple collections (default 0).",
      ),
    domain_index: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Download server index, e.g. 0 = Fast Partner Server #1 (default 0).",
      ),
  }),
  outputSchema: z.object({
    md5: z.string(),
    ok: z.boolean(),
    download_url: z.string().nullable(),
    error: z.string().nullable(),
    account_fast_download_info: z.unknown().nullable(),
    api_docs_hint: z.string(),
  }),
  async execute({ md5: raw, key: keyArg, path_index, domain_index }) {
    const md5 = normalizeMd5(raw);
    const api = await requestFastDownloadUrl(md5, {
      key: keyArg,
      path_index,
      domain_index,
    });
    return {
      md5,
      ok: api.ok,
      download_url: api.download_url,
      error: api.error,
      account_fast_download_info: api.account_fast_download_info,
      api_docs_hint:
        "Stable member API: /dyn/api/fast_download.json?md5=&key=. " +
        "To save under archive/: use anna_download.",
    };
  },
  toModelOutput(output) {
    if (output.ok && output.download_url) {
      return {
        type: "text" as const,
        value: `AA fast download ready for ${output.md5}: ${output.download_url}`,
      };
    }
    return {
      type: "text" as const,
      value: `AA fast download failed for ${output.md5}: ${output.error ?? "unknown error"}`,
    };
  },
});
