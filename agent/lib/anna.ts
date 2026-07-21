/**
 * Anna's Archive programmatic helpers.
 *
 * Prefer the APIs and bulk dumps documented for machines:
 * https://annas-archive.gl/llms.txt
 * https://annas-archive.gl/blog/llms-txt.html
 *
 * Do not scrape HTML search pages (CAPTCHAs). There is no public search API.
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

export function annaSecretKey(): string | undefined {
  const key = process.env.ANNA_ARCHIVE_SECRET_KEY?.trim();
  return key || undefined;
}

/** Browser-like UA; DDoS-Guard often 403s bare bot UAs on non-/dyn paths. */
const AA_USER_AGENT =
  "Mozilla/5.0 (compatible; eve-agent/anna; +https://annas-archive.gl/llms.txt)";

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
