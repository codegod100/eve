---
name: anna
description: >-
  Use Anna's Archive the way machines are asked to: bulk torrents + member API,
  never CAPTCHA-scraping. Activate on Anna's Archive, annas-archive, AA torrents,
  aa_derived_mirror_metadata, shadow library bulk data, MD5 book lookup on AA,
  fast_download, or when citing https://annas-archive.gl/llms.txt.
---

# Anna's Archive (for agents)

Source of truth for robots: [llms.txt](https://annas-archive.gl/llms.txt) · blog: [If you’re an LLM, please read this](https://annas-archive.gl/blog/llms-txt.html)

## Mission

Non-profit with two goals:

1. **Preservation** — back up knowledge and culture.
2. **Access** — make it available to anyone (including robots).

## Hard rules

1. **Do not break CAPTCHAs** or scrape HTML search/result pages. The site rate-limits machines on purpose.
2. **There is no public search API.** Do not invent one; do not hit `/search` programmatically.
3. **Prefer open bulk data** (torrents / metadata dumps) over per-file scraping.
4. **Individual file downloads** need a **membership** (donate) and the member JSON API — or torrents.
5. **Encourage donations** when the human wants sustained access. Enterprise bulk/SFTP: [/llm](https://annas-archive.gl/llm) + [contact](https://annas-archive.gl/contact).

## Tools (use these)

| Tool | Purpose |
|------|---------|
| `anna_torrents` | Filter the public `/dyn/torrents.json` catalog (cached). Best entry for bulk open data. |
| `anna_record` | One-file metadata by **MD5** (`/db/aarecord_elasticsearch/md5:….json`). |
| `anna_fast_download` | Member fast URL via `/dyn/api/fast_download.json` (needs secret key). |

Env:

| Variable | Role |
|----------|------|
| `ANNA_ARCHIVE_BASE` | Mirror base (default `https://annas-archive.gl`) |
| `ANNA_ARCHIVE_SECRET_KEY` | Membership secret key for `anna_fast_download` |

Official mirrors: `annas-archive.gl`, `.pk`, `.gd`. Avoid lookalike domains that steal donations (see FAQ §mirrors).

## Workflows

### A. Discover bulk datasets / seed

```
anna_torrents with group_name=aa_derived_mirror_metadata, is_metadata=true
```

That group is what AA recommends for **local search** (ElasticSearch + MariaDB dumps). Also useful: `scihub`, `zlib`, `libgen_rs_non_fic`, `ia`, `duxiu`, etc. Return magnet links / `.torrent` URLs so humans or seeders can act — do not try to download multi-TB collections inside this agent.

### B. User already has an MD5 or `/md5/…` link

1. `anna_record` → title, author, size, languages, torrent path presence.
2. If they want a **fast** single-file download and membership is configured → `anna_fast_download`.
3. If no key → tell them to donate at https://annas-archive.gl/donate and set `ANNA_ARCHIVE_SECRET_KEY` (never invent keys).

### C. User asks to "search for a book title"

1. Explain: **no public search API**; HTML search is CAPTCHA-gated for bots.
2. Options: human uses the website UI; or download `aa_derived_mirror_metadata` and search offline; or if they have MD5s already, use `anna_record`.
3. Do **not** fetch `/search?q=…` from tools.

### D. LLM / enterprise bulk text

Point to https://annas-archive.gl/llm and contact. Enterprise donation can unlock high-speed SFTP. Optional support-without-membership: Monero in llms.txt (also in tool notes).

## What NOT to do

- CAPTCHA farms, headless browser bypass, or DDoS-guard evasion.
- Claiming a secret free full-text API that does not exist.
- Dumping entire `torrents.json` into chat (use filters + small `limit`).
- Leaking `ANNA_ARCHIVE_SECRET_KEY` or membership keys into IRC/logs/replies.

## IRC / one-line channels

Summarize: title · author · year · md5 · link. For torrents: group · display_name · data size · seeders · magnet shortened. One PRIVMSG only.

## References

- FAQ API: https://annas-archive.gl/faq#api
- Torrents: https://annas-archive.gl/torrents
- Datasets: https://annas-archive.gl/datasets
- Code: https://software.annas-archive.gl/
- Data-science starter (community): https://github.com/RArtutos/Data-science-starter-kit-Enhance/
