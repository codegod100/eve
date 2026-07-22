---
name: linear
description: >-
  Linear issues for the eve project only. ALWAYS create a ticket when someone
  gives feedback, a suggestion, a bug report, or a feature idea. Also: status
  overview, list/filter, get/update issues. LINEAR_API_KEY from OpenBao.
  Activate on feedback, suggestion, idea, bug, ticket, Linear, board status.
---

# Linear (eve project)

All tools are **hard-scoped** to the Linear project named **eve** (override with
`LINEAR_PROJECT_NAME` / `LINEAR_PROJECT_ID`). Issues outside that project are
rejected. Never invent issue ids or print `LINEAR_API_KEY`.

Auth: personal API key in OpenBao path `secret/data/ai-api-keys` as
`LINEAR_API_KEY`, injected by `scripts/fetch-keys.sh` / `scripts/start.sh`.

## Rule: feedback → ticket (always)

**Whenever** a human gives **feedback**, a **suggestion**, a **feature idea**, a
**bug report**, a **complaint**, or a **product/UX request** about eve (or
related stack: IRC, radio, rook, tools, skills), you **must** create a Linear
issue with **`linear_create_issue`** on the eve project. Do this **in the same
turn** — do not only acknowledge in chat.

### When it counts

Create a ticket if they:

- Suggest a change, improvement, or new behavior
- Report something broken, missing, or confusing
- Give opinions on UX/tone/tools (“should…”, “wish…”, “please add…”, “bug:…”)
- File work explicitly (“open a ticket”, “track this”, “put it on the board”)

### When to skip

Do **not** create a ticket for:

- Pure Q&A with no ask to change product (“what is thermals?”)
- Status checks (“what’s open on Linear?”) — use `linear_status` / `linear_issues`
- Transient ops (“restart the bridge”, “play radio”) unless they also want it tracked
- They explicitly say **don’t** open a ticket / don’t track this

If unsure whether it is feedback vs chitchat: **create the ticket** (prefer over-capture).

### How to file

1. Optional: `linear_issues` with a short `query` to avoid an obvious duplicate of
   a still-open issue; if a clear open dupe exists, comment via update description
   or tell them the existing id — do not spam duplicates.
2. **`linear_create_issue`**:
   - **title**: short imperative summary (≤80 chars), e.g. `Add Linear status to IRC one-liners`
   - **description** (markdown):
     - What they said (paraphrase + quote key phrases)
     - Who: IRC nick if known
     - Context: channel / that it was feedback or suggestion
     - Acceptance notes if obvious
   - **priority**: `3` normal default; `2` if clearly blocking; `1` only if urgent outage; `4` nice-to-have
   - **state**: leave default / backlog unless they want it started
3. Reply (IRC one line) with the new **identifier** + title, e.g.  
   `nandi: filed SWARM-44 "…" — thanks, tracked on Linear eve.`

Never invent identifiers. Never print the API key. Always scope is the **eve** project only.

## Tools

| Tool | Purpose |
|------|---------|
| **`linear_create_issue`** | File feedback/suggestions (and any new work) on eve |
| **`linear_status`** | Project progress + counts by state + sample open issues |
| **`linear_issues`** | List/filter issues (query, state, state_type, assignee) |
| **`linear_issue`** | Full detail for one id / identifier |
| `linear_update_issue` | Update title/description/priority/state/assignee (eve only) |

## Env

| Variable | Role |
|----------|------|
| `LINEAR_API_KEY` | OpenBao key → GraphQL `Authorization` header |
| `LINEAR_PROJECT_NAME` | Project name lookup (default **`eve`**) |
| `LINEAR_PROJECT_ID` | Optional UUID; skips name lookup |

## Other workflows

### Status / “how’s the project?”

1. **`linear_status`** — open/started/completed counts + sample.
2. Drill with **`linear_issues`** (`state_type=started`, etc.).

### Find items

- Open work: `linear_issues` (default excludes completed/canceled).
- Search: `linear_issues` with `query`.
- One ticket: `linear_issue` with `id=TEAM-123`.

### Update

- `linear_update_issue` with id + fields; `state` accepts name (`Done`) or type (`completed`).
- Unassign: `assignee=""`.

Priority: `0` none · `1` urgent · `2` high · `3` normal · `4` low.

## Hard rules

1. Never leak `LINEAR_API_KEY`.
2. Do not query or mutate issues outside the configured eve project.
3. **Feedback/suggestion → `linear_create_issue` same turn** (see above).
4. If key missing: tell human to put `LINEAR_API_KEY` in OpenBao `ai-api-keys` and restart via `start.sh`.
5. IRC: one line — e.g. `nandi: filed SWARM-44 "…"; linear eve: 4 open, 2 started.`

## API

- Endpoint: `https://api.linear.app/graphql`
- Docs: https://linear.app/developers/graphql · https://linear.app/developers/filtering
