---
name: anna
description: >-
  Anna's Archive: search→MD5 via annas-mcp (anna_search), bibliography via
  Open Library, torrents, member download to ~/archive via ANNA_API_KEY.
  Activate on AA, ISBN/title, md5, download, archive, llms.txt, annas-mcp.
---

# Anna's Archive (for agents)

Sources: [llms.txt](https://annas-archive.gl/llms.txt) · [blog](https://annas-archive.gl/blog/llms-txt.html) · [FAQ §api](https://annas-archive.gl/faq#api) · [annas-mcp](https://github.com/iosifache/annas-mcp)

## Policy in one line

Prefer **search tools that return MD5s** and **member JSON download by MD5**; do not hand-roll CAPTCHA scrapers or invent a secret official search API. Bulk `aa_derived_mirror_metadata` (~1.5 TB) is for offline indexing, **not** required for a single-book lookup.

## Tools

| Tool | Purpose |
|------|---------|
| **`anna_search`** | **Primary** book search (ISBN/title/author) via `annas-mcp book-search` → **MD5s** |
| `anna_article_search` | Papers by DOI/keywords via `annas-mcp article-search` |
| `openlibrary_isbn` | Bibliography only (Open Library) |
| `anna_record` | Unified AA metadata for one **MD5** |
| `anna_fast_download` | Member API → **URL only** (`ANNA_API_KEY`) |
| **`anna_download`** | Member API → **save file** under archive dir (`~/archive` by default) |
| `anna_torrents` | Bulk torrents list — dumps/seeding, not one ISBN |

Env:

| Variable | Role |
|----------|------|
| `ANNA_API_KEY` | OpenBao membership secret → JSON download API |
| `ANNA_DOWNLOAD_DIR` | Where files land (default **`~/archive`**) |
| `ANNAS_MCP_BIN` | Optional path to `annas-mcp` binary |
| `ANNA_ARCHIVE_BASE` | Mirror host (default `https://annas-archive.gl`) |

Install CLI: `bash scripts/install-annas-mcp.sh` → `~/.local/bin/annas-mcp`.

## Workflow A — “lookup ISBN / title on Anna’s Archive”

1. Optional: `openlibrary_isbn` if you want clean bibliography.  
2. **`anna_search`** with ISBN or title — return top hits with **md5, format, size, url**.  
3. Prefer a sensible hit (matching title/author; ignore obvious false positives).  
4. `anna_record` on chosen md5 if more metadata needed.  
5. User wants the file saved → **`anna_download`** (writes to `ANNA_DOWNLOAD_DIR` / `~/archive`). URL only → `anna_fast_download`. Never print the key.

Do **not** lead with “download 1.5 TB metadata” for a single book.

## Workflow B — MD5 already known

`anna_record` → **`anna_download`** (save) or `anna_fast_download` (URL).

## Workflow C — bulk / offline index

`anna_torrents` `group_name=aa_derived_mirror_metadata` → magnet/size/seeders. Large (~TB).

## Hard rules

1. Never invent MD5s or leak `ANNA_API_KEY`.  
2. Do not build custom CAPTCHA bypass; use **annas-mcp** (maintained CLI) or bulk dumps.  
3. Official mirrors only for URLs you hand humans: `.gl`, `.pk`, `.gd`.  
4. If `anna_search` fails (binary missing), tell human to run `scripts/install-annas-mcp.sh` or paste an md5.

## IRC (one line)

`ISBN … → hits md5=… fmt=…; saved → ~/archive/….epub (or URL via fast_download).`

## References

- https://github.com/iosifache/annas-mcp  
- https://annas-archive.gl/llms.txt  
- https://annas-archive.gl/faq#api  
