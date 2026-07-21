import { defineTool } from "eve/tools";
import { z } from "zod";

const DEFAULT_APPVIEW = "https://public.api.bsky.app";

function appviewBase(): string {
  return (process.env.ATPROTO_APPVIEW_URL ?? DEFAULT_APPVIEW).replace(/\/$/, "");
}

/** True if the string looks like a DID (did:plc:… / did:web:…). */
function isDid(value: string): boolean {
  return /^did:[a-z0-9]+:/i.test(value);
}

/** Strip a leading @ and lowercase a handle. */
function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

/** Normalize actor input: DID as-is (trimmed), handle without @ and lowercased. */
function normalizeActor(raw: string): string {
  const trimmed = raw.trim();
  if (isDid(trimmed)) return trimmed;
  return normalizeHandle(trimmed);
}

type FeedPostView = {
  uri?: string;
  cid?: string;
  author?: { did?: string; handle?: string; displayName?: string };
  record?: {
    text?: string;
    createdAt?: string;
    reply?: unknown;
    embed?: { $type?: string };
  };
  indexedAt?: string;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
};

type FeedItem = {
  post?: FeedPostView;
  reason?: { $type?: string; by?: { handle?: string; did?: string } };
};

const postSchema = z.object({
  uri: z.string(),
  cid: z.string().optional(),
  text: z.string(),
  createdAt: z.string().optional(),
  indexedAt: z.string().optional(),
  isReply: z.boolean(),
  isRepost: z.boolean(),
  repostedBy: z.string().optional(),
  likeCount: z.number().optional(),
  repostCount: z.number().optional(),
  replyCount: z.number().optional(),
  quoteCount: z.number().optional(),
  embedType: z.string().optional(),
});

export default defineTool({
  description:
    "Fetch recent Bluesky/AT Protocol posts for an account by DID or handle. " +
    "Pass either a did:plc:… / did:web:… identifier or a handle like alice.bsky.social. " +
    "Returns a compact list of recent posts (text, timestamps, engagement counts).",
  inputSchema: z.object({
    actor: z
      .string()
      .min(1)
      .describe(
        "Account to fetch posts for: a DID (did:plc:… or did:web:…) or a handle " +
          "(e.g. nandi.uk, @jay.bsky.team).",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("How many feed items to return (1–50). Defaults to 10."),
    includeReposts: z
      .boolean()
      .optional()
      .describe(
        "If false, skip reposts and only return original posts (and replies). Defaults to true.",
      ),
  }),
  outputSchema: z.object({
    actor: z.string().describe("Normalized actor that was queried."),
    did: z.string().optional().describe("Author DID when present on the first post."),
    handle: z.string().optional().describe("Author handle when present on the first post."),
    count: z.number().describe("Number of posts returned."),
    posts: z.array(postSchema),
  }),
  async execute({ actor, limit = 10, includeReposts = true }) {
    const normalized = normalizeActor(actor);
    if (!isDid(normalized) && !normalized.includes(".")) {
      throw new Error(
        `Invalid actor "${actor}": expected a DID (did:plc:…) or domain-style handle (name.bsky.social)`,
      );
    }

    // Over-fetch a bit when filtering out reposts so we still fill `limit`.
    const fetchLimit = includeReposts ? limit : Math.min(50, limit * 2);

    const url = new URL(`${appviewBase()}/xrpc/app.bsky.feed.getAuthorFeed`);
    url.searchParams.set("actor", normalized);
    url.searchParams.set("limit", String(fetchLimit));

    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = (await res.json()) as { message?: string; error?: string };
        detail = body.message ?? body.error ?? detail;
      } catch {
        // ignore non-JSON error bodies
      }
      throw new Error(
        `Failed to fetch posts for "${normalized}" (${res.status}): ${detail}`,
      );
    }

    const data = (await res.json()) as { feed?: FeedItem[] };
    const feed = Array.isArray(data.feed) ? data.feed : [];

    const posts: z.infer<typeof postSchema>[] = [];
    let authorDid: string | undefined;
    let authorHandle: string | undefined;

    for (const item of feed) {
      const post = item.post;
      if (!post?.uri) continue;

      const reasonType = item.reason?.$type ?? "";
      const isRepost = reasonType.includes("reasonRepost");
      if (isRepost && !includeReposts) continue;

      if (!authorDid && post.author?.did) authorDid = post.author.did;
      if (!authorHandle && post.author?.handle) authorHandle = post.author.handle;

      const text =
        typeof post.record?.text === "string" ? post.record.text : "";
      const embedType =
        typeof post.record?.embed?.$type === "string"
          ? post.record.embed.$type
          : undefined;

      posts.push({
        uri: post.uri,
        cid: post.cid,
        text,
        createdAt: post.record?.createdAt,
        indexedAt: post.indexedAt,
        isReply: Boolean(post.record?.reply),
        isRepost,
        repostedBy: isRepost
          ? item.reason?.by?.handle ?? item.reason?.by?.did
          : undefined,
        likeCount: post.likeCount,
        repostCount: post.repostCount,
        replyCount: post.replyCount,
        quoteCount: post.quoteCount,
        embedType,
      });

      if (posts.length >= limit) break;
    }

    return {
      actor: normalized,
      did: authorDid,
      handle: authorHandle,
      count: posts.length,
      posts,
    };
  },
});
