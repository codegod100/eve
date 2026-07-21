import { defineTool } from "eve/tools";
import { z } from "zod";

// Bluesky public AppView — unauthenticated handle → DID resolution.
const DEFAULT_RESOLVE_URL =
  "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle";

/** Strip a leading @ and lowercase the handle. */
function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

export default defineTool({
  description:
    "Look up the AT Protocol DID for a Bluesky/ATProto handle (e.g. alice.bsky.social). " +
    "Use when you need a stable did:plc:… or did:web:… identifier for a user given their handle.",
  inputSchema: z.object({
    handle: z
      .string()
      .min(1)
      .describe(
        "AT Protocol handle to resolve, with or without a leading @ (e.g. jay.bsky.team or @jay.bsky.team).",
      ),
  }),
  outputSchema: z.object({
    handle: z.string().describe("Normalized handle that was resolved."),
    did: z.string().describe("Resolved DID (e.g. did:plc:…)."),
  }),
  async execute({ handle }) {
    const normalized = normalizeHandle(handle);
    if (!normalized.includes(".")) {
      throw new Error(
        `Invalid handle "${handle}": expected a domain-style handle like name.bsky.social`,
      );
    }

    const url = new URL(process.env.ATPROTO_RESOLVE_URL ?? DEFAULT_RESOLVE_URL);
    url.searchParams.set("handle", normalized);

    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
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
        `Failed to resolve handle "${normalized}" (${res.status}): ${detail}`,
      );
    }

    const data = (await res.json()) as { did?: string };
    if (!data.did || typeof data.did !== "string") {
      throw new Error(
        `Resolve response for "${normalized}" did not include a did field`,
      );
    }

    return { handle: normalized, did: data.did };
  },
});
