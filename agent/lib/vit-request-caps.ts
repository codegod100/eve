/** Fetch kind:request caps from explore.v-it.org and filter to controlled beacons. */

import { isControlledBeacon } from "./controlled-beacons.js";

export type ExploreRequestCap = {
  title?: string;
  description?: string;
  ref?: string;
  beacon?: string;
  uri?: string;
  handle?: string;
  kind?: string;
  created_at?: string;
  want_vouch_count?: number;
};

const DEFAULT_EXPLORE = "https://explore.v-it.org";

export function exploreBase(): string {
  return (process.env.VIT_EXPLORE_URL ?? DEFAULT_EXPLORE).replace(/\/$/, "");
}

export async function fetchExploreRequestCaps(
  limit = 50,
): Promise<ExploreRequestCap[]> {
  const url = new URL("/api/caps", exploreBase());
  url.searchParams.set("kind", "request");
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`explore caps failed (${res.status}): ${res.statusText}`);
  }
  const body = (await res.json()) as {
    caps?: ExploreRequestCap[];
    ok?: boolean;
  };
  return Array.isArray(body.caps) ? body.caps : [];
}

export async function fetchControlledRequestCaps(
  limit = 50,
): Promise<ExploreRequestCap[]> {
  const caps = await fetchExploreRequestCaps(limit);
  return caps.filter(
    (c) => c.kind === "request" && isControlledBeacon(c.beacon),
  );
}

/** Single IRC-safe line summarizing findings (no newlines). */
export function formatRequestCapsIrcLine(caps: ExploreRequestCap[]): string {
  if (caps.length === 0) {
    return "vit request-caps: no open kind:request caps on controlled beacons.";
  }
  const parts = caps.slice(0, 5).map((c) => {
    const ref = c.ref ?? "?";
    const title = (c.title ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    const beacon = (c.beacon ?? "?").replace(/^vit:/, "");
    const who = c.handle ? ` by ${c.handle}` : "";
    return `${ref} "${title}" @ ${beacon}${who}`;
  });
  const more = caps.length > 5 ? ` (+${caps.length - 5} more)` : "";
  return `vit request-caps (${caps.length}): ${parts.join(" | ")}${more}`;
}
