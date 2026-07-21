/**
 * Anna's Archive programmatic helpers.
 *
 * Prefer the APIs and bulk dumps documented for machines:
 * https://annas-archive.gl/llms.txt
 * https://annas-archive.gl/blog/llms-txt.html
 *
 * Do not scrape HTML search pages or bypass CAPTCHA/Cloudflare.
 * There is no public title/ISBN search API. For bibliography use Open Library
 * (openlibrary_isbn tool); for offline AA search use aa_derived_mirror_metadata
 * torrents; for one file use MD5 (anna_record / anna_fast_download).
 */

export const DEFAULT_AA_BASE = "https://annas-archive.gl";
export const OFFICIAL_MIRRORS = [
  "https://annas-archive.gl",
  "https://annas-archive.pk",
  "https://annas-archive.gd",
] as const;

/** Monero address for support-without-membership donations (from llms.txt). */
export const AA_XMR_ADDRESS =
  "88gS7a8aHj5EYhCfYnkhEmYXX3MtR35r3YhWdWXwGLyS4fkXYjkupcif6RY5oj9xkNR8VVmoRXh1kQKQrZBRRc8PHLWMgUR";

const TORRENTS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min; full list is ~17MB

export type AnnaTorrent = {
  url: string;
  top_level_group_name: string;
  group_name: string;
  display_name: string;
  added_to_torrents_list_at: string;
  is_metadata: boolean;
  btih: string;
  magnet_link: string;
  torrent_size: number;
  num_files: number;
  data_size: number;
  aa_currently_seeding: boolean;
  obsolete: boolean;
  embargo: boolean;
  seeders: number;
  leechers: number;
  completed: number;
  stats_scraped_at?: string;
  partially_broken: boolean;
};

type TorrentsCache = {
  fetchedAt: number;
  items: AnnaTorrent[];
};

let torrentsCache: TorrentsCache | null = null;

export function annaBase(): string {
  return (process.env.ANNA_ARCHIVE_BASE ?? DEFAULT_AA_BASE).replace(/\/$/, "");
}

/**
 * Membership secret for AA JSON APIs (`key=` on /dyn/api/fast_download.json).
 * Prefer OpenBao-injected `ANNA_API_KEY`; fall back to legacy env names.
 */
export function annaSecretKey(): string | undefined {
  const key =
    process.env.ANNA_API_KEY?.trim() ||
    process.env.ANNA_ARCHIVE_SECRET_KEY?.trim() ||
    process.env.ANNA_ARCHIVE_KEY?.trim();
  return key || undefined;
}

/** True when a membership API key is available (never log the value). */
export function hasAnnaApiKey(): boolean {
  return Boolean(annaSecretKey());
}

/** Browser-like UA; DDoS-Guard often 403s bare bot UAs on non-/dyn paths. */
const AA_USER_AGENT =
  "Mozilla/5.0 (compatible; eve-agent/anna; +https://annas-archive.gl/llms.txt)";

/**
 * Directory for saved AA files.
 * Prefer ANNA_DOWNLOAD_DIR, then ANNAS_DOWNLOAD_PATH (annas-mcp), else ~/archive.
 */
export function annaDownloadDir(): string {
  const raw =
    process.env.ANNA_DOWNLOAD_DIR?.trim() ||
    process.env.ANNAS_DOWNLOAD_PATH?.trim() ||
    "";
  if (raw) return raw.replace(/\/$/, "");
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return `${home}/archive`;
}

export type FastDownloadApiResult = {
  ok: boolean;
  download_url: string | null;
  error: string | null;
  account_fast_download_info: unknown | null;
  status: number;
};

/** Call member /dyn/api/fast_download.json (never log the key). */
export async function requestFastDownloadUrl(
  md5: string,
  opts: {
    key?: string;
    path_index?: number;
    domain_index?: number;
    timeoutMs?: number;
  } = {},
): Promise<FastDownloadApiResult> {
  const key = (opts.key?.trim() || annaSecretKey()) ?? "";
  if (!key) {
    return {
      ok: false,
      download_url: null,
      error:
        "No ANNA_API_KEY (OpenBao ai-api-keys) or key override. Donate at https://annas-archive.gl/donate",
      account_fast_download_info: null,
      status: 0,
    };
  }
  const { status, data } = await annaGetJson<{
    download_url: string | null;
    error?: string;
    account_fast_download_info?: unknown;
  }>(
    "/dyn/api/fast_download.json",
    {
      md5,
      key,
      path_index: opts.path_index,
      domain_index: opts.domain_index,
    },
    opts.timeoutMs ?? 30_000,
  );
  const downloadUrl =
    typeof data.download_url === "string" ? data.download_url : null;
  const ok =
    (status === 200 || status === 204) &&
    downloadUrl != null &&
    downloadUrl.length > 0;
  return {
    ok,
    download_url: downloadUrl,
    error: ok
      ? null
      : ((typeof data.error === "string" ? data.error : null) ??
        `HTTP ${status}`),
    account_fast_download_info: data.account_fast_download_info ?? null,
    status,
  };
}

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^["']|["']$/g, ""));
    } catch {
      /* fall through */
    }
  }
  const plain =
    header.match(/filename="([^"]+)"/i) ?? header.match(/filename=([^;]+)/i);
  if (plain?.[1]) return plain[1].trim().replace(/^["']|["']$/g, "");
  return null;
}

/** AA partner URLs often end with `Title -- Author -- … -- md5 -- Anna’s Archive.ext` */
function filenameFromDownloadUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").pop() ?? "");
    let base = last.split("~/")[0] ?? last;
    if (!base || /^[a-f0-9]{32}\./i.test(base)) return null;
    if (base.includes("--")) {
      const extMatch = base.match(/\.([a-z0-9]{2,5})$/i);
      const ext = extMatch?.[1] ?? "";
      const parts = base
        .replace(/\.[a-z0-9]{2,5}$/i, "")
        .split(/\s*--\s*/)
        .map((p) => p.trim())
        .filter(Boolean);
      const cleaned = parts.filter(
        (p) =>
          !/^[a-f0-9]{32}$/i.test(p) &&
          !/^isbn/i.test(p) &&
          !/anna.?s?\s*archive/i.test(p) &&
          !/^open road/i.test(p),
      );
      if (cleaned.length >= 1) {
        const title = cleaned[0]!.replace(/\s*:\s*/g, " - ").slice(0, 100);
        const author = cleaned[1]?.replace(/,.*$/, "").trim();
        const year = cleaned
          .find((p) => /\b(19|20)\d{2}\b/.test(p))
          ?.match(/\b((?:19|20)\d{2})\b/)?.[1];
        return buildIntelligibleName({
          title,
          author: author ?? null,
          year: year ?? null,
          extension: ext || null,
        });
      }
    }
    if (base.length > 8 && !/^[a-f0-9]{32}/i.test(base)) return base;
  } catch {
    /* ignore */
  }
  return null;
}

/** "Title - Author (Year).ext" — human-readable archive basename. */
export function buildIntelligibleName(meta: {
  title?: string | null;
  author?: string | null;
  year?: string | null;
  extension?: string | null;
}): string {
  let title = (meta.title ?? "").replace(/\s+/g, " ").trim();
  title = title.replace(/\s*:\s*/g, " - ").slice(0, 100);
  let author = (meta.author ?? "").replace(/\s+/g, " ").trim();
  if (author.includes(",")) {
    const bits = author.split(",").map((s) => s.trim());
    const last = bits[0];
    const first = bits[1];
    author = [first, last].filter(Boolean).join(" ") || author;
  }
  author = (author.split(/\s+and\s+|;/)[0] ?? author).trim().slice(0, 60);
  const year = (meta.year ?? "").match(/\b((?:19|20)\d{2})\b/)?.[1] ?? "";
  const ext =
    (meta.extension ?? "bin").replace(/^\./, "").toLowerCase() || "bin";

  let name = title || "download";
  if (author) name = `${name} - ${author}`;
  if (year) name = `${name} (${year})`;
  return safeBasename(`${name}.${ext}`);
}

function safeBasename(name: string): string {
  return (
    name
      .replace(/[/\\?%*:|"<>]/g, "_")
      .replace(/\s+/g, " ")
      .replace(/_+/g, "_")
      .trim()
      .slice(0, 180) || "download"
  );
}

export type ArchiveDownloadResult = {
  ok: boolean;
  md5: string;
  path: string | null;
  bytes: number | null;
  filename: string | null;
  download_url: string | null;
  error: string | null;
};

/**
 * Resolve member download URL and stream the file into annaDownloadDir().
 */
export async function downloadMd5ToArchive(
  md5Raw: string,
  opts: {
    key?: string;
    path_index?: number;
    domain_index?: number;
    filename?: string;
    title?: string | null;
    author?: string | null;
    year?: string | null;
    extension?: string;
    timeoutMs?: number;
  } = {},
): Promise<ArchiveDownloadResult> {
  const { mkdir, writeFile, access } = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  const pathMod = await import("node:path");

  const md5 = normalizeMd5(md5Raw);
  const api = await requestFastDownloadUrl(md5, opts);
  if (!api.ok || !api.download_url) {
    return {
      ok: false,
      md5,
      path: null,
      bytes: null,
      filename: null,
      download_url: null,
      error: api.error ?? "no download_url",
    };
  }

  const dir = annaDownloadDir();
  await mkdir(dir, { recursive: true });

  const res = await fetch(api.download_url, {
    headers: {
      "user-agent": AA_USER_AGENT,
      accept: "*/*",
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000),
    redirect: "follow",
  });
  if (!res.ok) {
    return {
      ok: false,
      md5,
      path: null,
      bytes: null,
      filename: null,
      download_url: api.download_url,
      error: `download fetch failed HTTP ${res.status}`,
    };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const ext =
    opts.extension?.replace(/^\./, "") ||
    guessExtFromContentType(res.headers.get("content-type")) ||
    sniffExtFromBytes(buf) ||
    "bin";

  // Prefer human-readable: explicit filename → title/author/year → URL → Content-Disposition → md5
  let filename =
    opts.filename?.trim() ||
    (opts.title
      ? buildIntelligibleName({
          title: opts.title,
          author: opts.author,
          year: opts.year,
          extension: ext,
        })
      : null) ||
    filenameFromDownloadUrl(api.download_url) ||
    filenameFromContentDisposition(res.headers.get("content-disposition"));

  if (!filename) {
    filename = `${md5}.${ext}`;
  } else if (!pathMod.extname(filename)) {
    filename = `${filename}.${ext}`;
  }
  // If we still only have a bare md5 name but URL has a better one, upgrade
  if (/^[a-f0-9]{32}\./i.test(filename)) {
    const fromUrl = filenameFromDownloadUrl(api.download_url);
    if (fromUrl) filename = fromUrl;
  }
  filename = safeBasename(filename);

  let outPath = pathMod.join(dir, filename);
  // Avoid clobber: if exists, add short md5 infix
  try {
    await access(outPath, constants.F_OK);
    const base = pathMod.parse(filename);
    outPath = pathMod.join(dir, `${base.name}-${md5.slice(0, 8)}${base.ext}`);
    filename = pathMod.basename(outPath);
  } catch {
    /* free to write */
  }

  await writeFile(outPath, buf);

  return {
    ok: true,
    md5,
    path: outPath,
    bytes: buf.length,
    filename,
    download_url: api.download_url,
    error: null,
  };
}

function guessExtFromContentType(ct: string | null): string | null {
  if (!ct) return null;
  const map: Record<string, string> = {
    "application/pdf": "pdf",
    "application/epub+zip": "epub",
    "application/x-mobipocket-ebook": "mobi",
    "application/vnd.amazon.ebook": "azw3",
    "application/zip": "zip",
    "application/x-rar-compressed": "rar",
    "text/plain": "txt",
  };
  const base = ct.split(";")[0]!.trim().toLowerCase();
  return map[base] ?? null;
}

function sniffExtFromBytes(buf: Buffer): string | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "pdf";
  }
  // EPUB is a zip; many AA responses omit content-type
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    const head = buf.subarray(0, Math.min(buf.length, 4096)).toString("utf8");
    if (head.includes("mimetype") && head.includes("epub")) return "epub";
    return "zip";
  }
  return null;
}

export async function annaGetJson<T>(
  path: string,
  query: Record<string, string | number | undefined> = {},
  timeoutMs = 60_000,
): Promise<{ status: number; data: T }> {
  const bases = [
    annaBase(),
    ...OFFICIAL_MIRRORS.filter((m) => m !== annaBase()),
  ];
  let lastErr: Error | null = null;

  for (const base of bases) {
    const url = new URL(path.startsWith("http") ? path : `${base}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }

    try {
      const res = await fetch(url, {
        headers: {
          accept: "application/json, text/json, */*",
          "user-agent": AA_USER_AGENT,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      const text = await res.text();
      const looksHtml =
        /^\s*</.test(text) ||
        /ddos-guard|just a moment|cf-browser-verification/i.test(text);

      if (looksHtml) {
        lastErr = new Error(
          `Anna's Archive ${url.host}${url.pathname} blocked by edge protection ` +
            `(${res.status}). Prefer /dyn/* APIs, torrents, or set ANNA_ARCHIVE_BASE ` +
            `to a working mirror. Do not CAPTCHA-scrape.`,
        );
        // try next mirror
        continue;
      }

      let data: T;
      try {
        data = JSON.parse(text) as T;
      } catch {
        lastErr = new Error(
          `Anna's Archive ${url.pathname} returned non-JSON (${res.status})`,
        );
        continue;
      }

      return { status: res.status, data };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }

  throw lastErr ?? new Error("Anna's Archive request failed on all mirrors");
}

/** Normalize an MD5: strip md5: prefix, lowercase, validate hex. */
export function normalizeMd5(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (s.startsWith("md5:")) s = s.slice(4);
  // allow pasting full AA URLs or paths
  const fromUrl = s.match(/(?:md5[/:]|md5%3a)([a-f0-9]{32})/i);
  if (fromUrl) s = fromUrl[1]!.toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(s)) {
    throw new Error(
      `Invalid md5 "${raw}": expected 32 hex chars (optionally with md5: prefix or AA URL)`,
    );
  }
  return s;
}

export async function fetchTorrents(
  forceRefresh = false,
): Promise<AnnaTorrent[]> {
  const now = Date.now();
  if (
    !forceRefresh &&
    torrentsCache &&
    now - torrentsCache.fetchedAt < TORRENTS_CACHE_TTL_MS
  ) {
    return torrentsCache.items;
  }

  const { status, data } = await annaGetJson<AnnaTorrent[]>(
    "/dyn/torrents.json",
    {},
    120_000,
  );
  if (status !== 200 || !Array.isArray(data)) {
    throw new Error(
      `Failed to fetch torrents.json (${status}): expected JSON array`,
    );
  }

  torrentsCache = { fetchedAt: now, items: data };
  return data;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(2) : v < 100 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export type AnnaRecordSummary = {
  md5: string;
  id: string;
  title: string | null;
  author: string | null;
  year: string | null;
  publisher: string | null;
  extension: string | null;
  filesize: number | null;
  filesize_human: string | null;
  language_codes: string[];
  content_type: string | null;
  cover_url: string | null;
  description: string | null;
  identifiers: Record<string, string[]> | null;
  has_torrent_paths: boolean | null;
  torrent_paths: unknown[] | null;
  has_aa_downloads: boolean | null;
  page_url: string;
  record_json_url: string;
};

export function summarizeRecord(
  md5: string,
  raw: Record<string, unknown>,
): AnnaRecordSummary {
  const f = (raw.file_unified_data ?? {}) as Record<string, unknown>;
  const additional = (raw.additional ?? {}) as Record<string, unknown>;
  const filesize = typeof f.filesize_best === "number" ? f.filesize_best : null;
  const identifiers =
    f.identifiers_unified && typeof f.identifiers_unified === "object"
      ? (f.identifiers_unified as Record<string, string[]>)
      : null;

  const language =
    (Array.isArray(f.most_likely_language_codes)
      ? (f.most_likely_language_codes as string[])
      : null) ??
    (Array.isArray(f.language_codes) ? (f.language_codes as string[]) : []) ??
    [];

  const torrentPaths = Array.isArray(additional.torrent_paths)
    ? (additional.torrent_paths as unknown[])
    : null;

  return {
    md5,
    id: typeof raw.id === "string" ? raw.id : `md5:${md5}`,
    title: strOrNull(f.title_best),
    author: strOrNull(f.author_best),
    year: strOrNull(f.year_best),
    publisher: strOrNull(f.publisher_best),
    extension: strOrNull(f.extension_best),
    filesize,
    filesize_human: filesize != null ? formatBytes(filesize) : null,
    language_codes: language,
    content_type: strOrNull(f.content_type_best),
    cover_url: strOrNull(f.cover_url_best),
    description: strOrNull(f.stripped_description_best),
    identifiers,
    has_torrent_paths:
      typeof f.has_torrent_paths === "boolean" ? f.has_torrent_paths : null,
    torrent_paths: torrentPaths,
    has_aa_downloads:
      typeof f.has_aa_downloads === "boolean"
        ? f.has_aa_downloads
        : typeof additional.has_aa_downloads === "boolean"
          ? additional.has_aa_downloads
          : null,
    page_url: `${annaBase()}/md5/${md5}`,
    record_json_url: `${annaBase()}/db/aarecord_elasticsearch/md5:${md5}.json`,
  };
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
