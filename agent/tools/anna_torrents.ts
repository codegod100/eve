import { defineTool } from "eve/tools";
import { z } from "zod";
import { fetchTorrents, formatBytes, type AnnaTorrent } from "../lib/anna.js";

const torrentOut = z.object({
  group_name: z.string(),
  top_level_group_name: z.string(),
  display_name: z.string(),
  is_metadata: z.boolean(),
  obsolete: z.boolean(),
  embargo: z.boolean(),
  btih: z.string(),
  magnet_link: z.string(),
  url: z.string(),
  torrent_size: z.number(),
  torrent_size_human: z.string(),
  data_size: z.number(),
  data_size_human: z.string(),
  num_files: z.number(),
  seeders: z.number(),
  leechers: z.number(),
  aa_currently_seeding: z.boolean(),
  added_to_torrents_list_at: z.string(),
});

export default defineTool({
  description:
    "List/filter Anna's Archive torrents (/dyn/torrents.json) — the primary " +
    "robot access path in llms.txt. For ISBN/title 'search on AA', ALWAYS " +
    "call this with group_name=aa_derived_mirror_metadata and return the " +
    "newest dump's display_name, data size, seeders, and magnet/url so the " +
    "human can search ISBN→md5 offline. Not live title search. Never scrape " +
    "/search. Bibliography: openlibrary_isbn; one file: anna_record (md5).",
  inputSchema: z.object({
    group_name: z
      .string()
      .optional()
      .describe(
        "Exact group filter, e.g. aa_derived_mirror_metadata, scihub, zlib, " +
          "libgen_rs_non_fic, ia, duxiu, upload.",
      ),
    top_level_group_name: z
      .enum(["managed_by_aa", "external", "other_aa"])
      .optional()
      .describe("Top-level grouping filter."),
    is_metadata: z
      .boolean()
      .optional()
      .describe(
        "If true, only metadata torrents; if false, only file collections.",
      ),
    query: z
      .string()
      .optional()
      .describe(
        "Case-insensitive substring match on display_name or group_name.",
      ),
    include_obsolete: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include obsolete torrents (default false)."),
    include_embargo: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include embargoed torrents (default false)."),
    min_seeders: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Minimum seeder count."),
    sort: z
      .enum(["added_desc", "data_size_desc", "seeders_desc", "name_asc"])
      .optional()
      .default("added_desc")
      .describe("Sort order (default added_desc)."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(20)
      .describe("Max results to return (1–100, default 20)."),
    refresh: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Bypass the 30-minute in-memory cache and re-fetch torrents.json.",
      ),
  }),
  outputSchema: z.object({
    total_matching: z.number(),
    returned: z.number(),
    catalog_size: z.number(),
    groups_sample: z.array(z.string()),
    torrents: z.array(torrentOut),
    note: z.string(),
  }),
  async execute(input) {
    const items = await fetchTorrents(input.refresh === true);
    const q = input.query?.trim().toLowerCase();

    let filtered = items.filter((t) => {
      if (!input.include_obsolete && t.obsolete) return false;
      if (!input.include_embargo && t.embargo) return false;
      if (input.group_name && t.group_name !== input.group_name) return false;
      if (
        input.top_level_group_name &&
        t.top_level_group_name !== input.top_level_group_name
      ) {
        return false;
      }
      if (
        input.is_metadata !== undefined &&
        t.is_metadata !== input.is_metadata
      ) {
        return false;
      }
      if (
        input.min_seeders !== undefined &&
        (t.seeders ?? 0) < input.min_seeders
      ) {
        return false;
      }
      if (q) {
        const hay = `${t.display_name} ${t.group_name}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const sort = input.sort ?? "added_desc";
    filtered = [...filtered].sort((a, b) => {
      switch (sort) {
        case "data_size_desc":
          return (b.data_size ?? 0) - (a.data_size ?? 0);
        case "seeders_desc":
          return (b.seeders ?? 0) - (a.seeders ?? 0);
        case "name_asc":
          return a.display_name.localeCompare(b.display_name);
        case "added_desc":
        default:
          return (b.added_to_torrents_list_at ?? "").localeCompare(
            a.added_to_torrents_list_at ?? "",
          );
      }
    });

    const limit = input.limit ?? 20;
    const page = filtered.slice(0, limit);
    const groups = [...new Set(items.map((t) => t.group_name))].sort();

    return {
      total_matching: filtered.length,
      returned: page.length,
      catalog_size: items.length,
      groups_sample: groups.slice(0, 40),
      torrents: page.map(shapeTorrent),
      note:
        "Bulk open data only. For title search, download aa_derived_mirror_metadata " +
        "and query locally — AA has no public search API. Prefer seeding over " +
        "scraping. See skill `anna` / https://annas-archive.gl/llms.txt",
    };
  },
  toModelOutput(output) {
    const lines = output.torrents.map(
      (t) =>
        `${t.group_name}/${t.display_name} data=${t.data_size_human} ` +
        `seeders=${t.seeders} meta=${t.is_metadata} btih=${t.btih.slice(0, 12)}…`,
    );
    return {
      type: "text" as const,
      value:
        `Anna torrents: ${output.returned}/${output.total_matching} ` +
        `(catalog ${output.catalog_size}). ` +
        (lines.length ? lines.join(" | ") : "no matches") +
        ` — ${output.note}`,
    };
  },
});

function shapeTorrent(t: AnnaTorrent) {
  return {
    group_name: t.group_name,
    top_level_group_name: t.top_level_group_name,
    display_name: t.display_name,
    is_metadata: t.is_metadata,
    obsolete: t.obsolete,
    embargo: t.embargo,
    btih: t.btih,
    magnet_link: t.magnet_link,
    url: t.url,
    torrent_size: t.torrent_size,
    torrent_size_human: formatBytes(t.torrent_size),
    data_size: t.data_size,
    data_size_human: formatBytes(t.data_size),
    num_files: t.num_files,
    seeders: t.seeders ?? 0,
    leechers: t.leechers ?? 0,
    aa_currently_seeding: t.aa_currently_seeding,
    added_to_torrents_list_at: t.added_to_torrents_list_at,
  };
}
