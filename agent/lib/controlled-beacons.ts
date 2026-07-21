/**
 * Beacons this agent watches for kind:request caps on explore.v-it.org.
 *
 * Override with env `VIT_CONTROLLED_BEACONS` (comma-separated full beacon
 * strings). When unset, defaults cover nandi/codegod100-owned repos plus any
 * beacon whose path contains a listed owner fragment.
 */

const DEFAULT_BEACONS = [
  "vit:github.com/codegod100/zellij-right-click-tab",
  "vit:github.com/codegod100/obsidian-myst",
  "vit:github.com/codegod100/letta-chat",
  "vit:github.com/codegod100/lnk",
  "vit:github.com/codegod100/zellij",
] as const;

/** Owner/path fragments that mark a beacon as "ours" when not listed exactly. */
const DEFAULT_OWNER_FRAGMENTS = ["codegod100"] as const;

function splitCsv(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getControlledBeacons(): string[] {
  const fromEnv = splitCsv(process.env.VIT_CONTROLLED_BEACONS);
  return fromEnv.length > 0 ? fromEnv : [...DEFAULT_BEACONS];
}

export function getControlledOwnerFragments(): string[] {
  const fromEnv = splitCsv(process.env.VIT_CONTROLLED_BEACON_OWNERS);
  return fromEnv.length > 0 ? fromEnv : [...DEFAULT_OWNER_FRAGMENTS];
}

/** True when the beacon is explicitly listed or matches an owner fragment. */
export function isControlledBeacon(beacon: string | undefined | null): boolean {
  if (!beacon) return false;
  const exact = new Set(getControlledBeacons());
  if (exact.has(beacon)) return true;
  // Normalize github.com URLs without vit: prefix
  if (exact.has(`vit:${beacon.replace(/^https?:\/\//, "")}`)) return true;
  const lower = beacon.toLowerCase();
  return getControlledOwnerFragments().some((frag) => lower.includes(frag.toLowerCase()));
}
