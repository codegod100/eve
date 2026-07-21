import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  annaGetJson,
  annaSecretKey,
  normalizeMd5,
} from "../lib/anna.js";

type FastDownloadResponse = {
  download_url: string | null;
  error?: string;
  account_fast_download_info?: unknown;
  ///download_url?: string[];
};

export default defineTool({
  description:
    "Get a member fast-download URL for one file from Anna's Archive " +
    "(/dyn/api/fast_download.json). Requires a membership secret key via " +
    "env ANNA_ARCHIVE_SECRET_KEY or the key argument. Pass the file md5. " +
    "Never invent keys; if missing, tell the human to donate at /donate " +
    "and set the key. Do not use CAPTCHA-breaking scrapers.",
  inputSchema: z.object({
    md5: z
      .string()
      .min(1)
      .describe("32-char MD5 of the file (or md5:… / AA URL)."),
    key: z
      .string()
      .optional()
      .describe(
        "Account secret key. Prefer env ANNA_ARCHIVE_SECRET_KEY; only pass " +
          "when the human explicitly provided a key this turn.",
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
    const key = (keyArg?.trim() || annaSecretKey()) ?? "";
    if (!key) {
      throw new Error(
        "No Anna's Archive secret key. Donate for membership at " +
          "https://annas-archive.gl/donate then set ANNA_ARCHIVE_SECRET_KEY " +
          "or pass key= from the human. See https://annas-archive.gl/faq#api",
      );
    }

    const query: Record<string, string | number | undefined> = {
      md5,
      key,
      path_index,
      domain_index,
    };

    const { status, data } = await annaGetJson<FastDownloadResponse>(
      "/dyn/api/fast_download.json",
      query,
      30_000,
    );

    const downloadUrl =
      typeof data.download_url === "string" ? data.download_url : null;
    const ok =
      (status === 200 || status === 204) && downloadUrl != null && downloadUrl.length > 0;

    return {
      md5,
      ok,
      download_url: downloadUrl,
      error: ok
        ? null
        : (typeof data.error === "string" ? data.error : null) ??
          `HTTP ${status}`,
      account_fast_download_info: data.account_fast_download_info ?? null,
      api_docs_hint:
        "Stable member API: /dyn/api/fast_download.json?md5=&key= " +
        "Optional path_index, domain_index. Docs live inside the JSON " +
        "///download_url field. Bulk alternative: torrents + /llm enterprise SFTP.",
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
