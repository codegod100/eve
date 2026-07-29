import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Start streaming internet radio into the freeq AV call on a channel.
 * Orchestrated by irc-bridge control → eve-av-bridge → ffmpeg → MoQ.
 *
 * Default station is SomaFM Groove Salad. Pass a station name (or phrase
 * like "def con" / "play radio drone") to pick another SomaFM channel.
 */

const CONTROL = process.env.IRC_CONTROL_URL ?? "http://127.0.0.1:8791";
const AV = process.env.AV_BRIDGE_URL ?? "http://127.0.0.1:8790";

/** Build a SomaFM ice1 MP3 stream URL from a channel id. */
function somafmUrl(id: string): string {
  return `https://ice1.somafm.com/${id}-128-mp3`;
}

type Station = { url: string; label: string; id: string };

function station(id: string, label: string): Station {
  return { id, label, url: somafmUrl(id) };
}

/** Canonical stations (SomaFM channel id → meta). */
const CANONICAL: Record<string, Station> = {
  groovesalad: station("groovesalad", "SomaFM Groove Salad"),
  dronezone: station("dronezone", "SomaFM Drone Zone"),
  beatblender: station("beatblender", "SomaFM Beat Blender"),
  defcon: station("defcon", "SomaFM DEF CON Radio"),
  deepspaceone: station("deepspaceone", "SomaFM Deep Space One"),
  indiepop: station("indiepop", "SomaFM Indie Pop Rocks"),
  metal: station("metal", "SomaFM Metal Detector"),
  fluid: station("fluid", "SomaFM Fluid"),
  lush: station("lush", "SomaFM Lush"),
  secretagent: station("secretagent", "SomaFM Secret Agent"),
  spacestation: station("spacestation", "SomaFM Space Station"),
  thetrip: station("thetrip", "SomaFM The Trip"),
  vaporwaves: station("vaporwaves", "SomaFM Vaporwaves"),
  darkzone: station("darkzone", "SomaFM The Dark Zone"),
  dubstep: station("dubstep", "SomaFM Dub Step Beyond"),
  cliqhop: station("cliqhop", "SomaFM cliqhop idm"),
  synphaera: station("synphaera", "SomaFM Synphaera Radio"),
  digitalis: station("digitalis", "SomaFM Digitalis"),
  poptron: station("poptron", "SomaFM PopTron"),
  seventies: station("seventies", "SomaFM Left Coast 70s"),
  u80s: station("u80s", "SomaFM Underground 80s"),
  bossa: station("bossa", "SomaFM Bossa Beyond"),
  reggae: station("reggae", "SomaFM Heavyweight Reggae"),
  thistle: station("thistle", "SomaFM ThistleRadio"),
  missioncontrol: station("missioncontrol", "SomaFM Mission Control"),
  sf1033: station("sf1033", "SomaFM SF 10-33"),
  n5md: station("n5md", "SomaFM n5MD Radio"),
};

const DEFAULT_STATION = CANONICAL.groovesalad;

/**
 * Alias keys (normalized: lowercase, no separators) → canonical id.
 * Multi-word names like "def con" normalize to "defcon".
 */
const ALIASES: Record<string, string> = {
  // default / groove salad
  groove: "groovesalad",
  groovesalad: "groovesalad",
  salad: "groovesalad",
  // drone
  drone: "dronezone",
  dronezone: "dronezone",
  // beat blender
  beat: "beatblender",
  beatblender: "beatblender",
  blender: "beatblender",
  // def con
  defcon: "defcon",
  def: "defcon",
  // deep space one
  deepspace: "deepspaceone",
  deepspaceone: "deepspaceone",
  deep: "deepspaceone",
  // indie pop
  indie: "indiepop",
  indiepop: "indiepop",
  // metal detector
  metal: "metal",
  metaldetector: "metal",
  // others (id == alias)
  fluid: "fluid",
  lush: "lush",
  secretagent: "secretagent",
  secret: "secretagent",
  agent: "secretagent",
  spacestation: "spacestation",
  space: "spacestation",
  thetrip: "thetrip",
  trip: "thetrip",
  vaporwaves: "vaporwaves",
  vapor: "vaporwaves",
  vaporwave: "vaporwaves",
  darkzone: "darkzone",
  dark: "darkzone",
  dubstep: "dubstep",
  dub: "dubstep",
  cliqhop: "cliqhop",
  cliq: "cliqhop",
  synphaera: "synphaera",
  digitalis: "digitalis",
  poptron: "poptron",
  seventies: "seventies",
  leftcoast: "seventies",
  leftcoast70s: "seventies",
  u80s: "u80s",
  underground80s: "u80s",
  bossa: "bossa",
  bossabeyond: "bossa",
  reggae: "reggae",
  thistle: "thistle",
  thistleradio: "thistle",
  missioncontrol: "missioncontrol",
  mission: "missioncontrol",
  sf1033: "sf1033",
  n5md: "n5md",
};

/** Words that are command filler, not station names. */
const NOISE =
  /\b(play|put\s+on|stream|tune\s+(?:in\s+)?to|switch\s+to|somafm|soma\.?fm|soma|station|channel|please|some|music|the|a|an|on|for|me|us|now|fm)\b/gi;

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Resolve free-text station input to a stream URL + label.
 * Accepts: empty (default), aliases ("def con", "groove"), SomaFM ids,
 * full phrases ("play radio def con"), or raw http(s) URLs.
 */
export function resolveStation(input: string | undefined): Station {
  if (!input || !input.trim()) return DEFAULT_STATION;
  const raw = input.trim();
  if (/^https?:\/\//i.test(raw)) {
    return { id: "url", url: raw, label: raw };
  }

  // Strip command filler, then normalize separators.
  // "play radio" alone → empty stripped → default (do not fall back to raw).
  const stripped = raw.replace(NOISE, " ").replace(/\bradio\b/gi, " ").trim();
  if (!stripped) return DEFAULT_STATION;
  const key = normalizeKey(stripped);
  if (!key) return DEFAULT_STATION;

  // Exact alias / canonical id.
  if (ALIASES[key] && CANONICAL[ALIASES[key]]) {
    return CANONICAL[ALIASES[key]];
  }
  if (CANONICAL[key]) return CANONICAL[key];

  // Longest alias that is a substring of the key (prefer longer matches).
  let best: { alias: string; id: string } | null = null;
  for (const [alias, id] of Object.entries(ALIASES)) {
    if (alias.length < 3) continue; // avoid short false positives (def, dub)
    if (key.includes(alias) || alias.includes(key)) {
      if (!best || alias.length > best.alias.length) {
        best = { alias, id };
      }
    }
  }
  if (best && CANONICAL[best.id]) return CANONICAL[best.id];

  // Label substring match (e.g. "groove salad", "def con radio").
  const needle = (stripped || raw).toLowerCase();
  for (const s of Object.values(CANONICAL)) {
    const labelKey = normalizeKey(s.label);
    if (
      labelKey.includes(key) ||
      key.includes(normalizeKey(s.label.replace(/^somafm\s+/i, ""))) ||
      s.label.toLowerCase().includes(needle)
    ) {
      return s;
    }
  }

  // Unknown but looks like a SomaFM channel id — try ice1 directly.
  if (/^[a-z][a-z0-9]{1,31}$/i.test(key)) {
    return {
      id: key,
      label: `SomaFM ${key}`,
      url: somafmUrl(key),
    };
  }

  return DEFAULT_STATION;
}

async function probeJson(
  url: string,
  timeoutMs = 3_000,
): Promise<{ ok: boolean; status?: number; body?: unknown; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* plain */
    }
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const STATION_HINT =
  "groovesalad (default), defcon, drone, beatblender, deepspace, indie, metal, fluid, lush, secretagent, spacestation, … or any SomaFM id / http(s) URL";

export default defineTool({
  description:
    "Play internet radio into the freeq AV call (default #test). " +
    "ALWAYS call this for 'play radio', 'play radio <station>', station names, or stream URLs. " +
    "Pass only the station name in `station` (e.g. 'def con', 'drone', 'groove salad') — " +
    "omit station (or empty) for Groove Salad. Never invent stack inventory; pair with stop_radio.",
  inputSchema: z.object({
    station: z
      .string()
      .optional()
      .describe(
        `Station name or phrase. Examples: 'def con', 'drone', 'groove salad', 'fluid'. ${STATION_HINT}. Default: groovesalad.`,
      ),
    channel: z.string().optional().describe("IRC channel for AV, e.g. #test."),
  }),
  async execute({ station, channel }) {
    const resolved = resolveStation(station);

    // Live probes — return facts only, never invent stack inventory.
    const [ctrl, avHealth, avStatusBefore] = await Promise.all([
      probeJson(`${CONTROL}/health`),
      probeJson(`${AV}/health`),
      probeJson(`${AV}/v1/status`),
    ]);

    if (!ctrl.ok) {
      return {
        ok: false,
        station: resolved.label,
        station_id: resolved.id,
        url: resolved.url,
        error: `irc-bridge control unreachable at ${CONTROL}: ${ctrl.error || ctrl.status}`,
        probes: { control: ctrl, av: avHealth },
        say: "Radio control is down right now — try again in a bit.",
      };
    }
    if (!avHealth.ok) {
      return {
        ok: false,
        station: resolved.label,
        station_id: resolved.id,
        url: resolved.url,
        error: `eve-av-bridge unreachable at ${AV}: ${avHealth.error || avHealth.status}`,
        probes: { control: ctrl, av: avHealth },
        say: "AV media plane is down right now — try again in a bit.",
      };
    }

    const res = await fetch(`${CONTROL}/radio/play`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: resolved.url,
        channel: channel || undefined,
        title: `eve radio: ${resolved.label}`,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      av?: { channel?: string; sessionId?: string };
      radio?: { playing?: boolean; url?: string };
    };

    // Re-check media plane after play (source of truth).
    const after = await probeJson(`${AV}/v1/status`);
    const afterBody = after.body as
      | {
          radio?: { playing?: boolean; url?: string };
          session?: { channel?: string; session_id?: string; nick?: string };
        }
      | undefined;
    const playing = Boolean(afterBody?.radio?.playing ?? json.radio?.playing);

    if (!res.ok || json.ok === false || !playing) {
      return {
        ok: false,
        station: resolved.label,
        station_id: resolved.id,
        url: resolved.url,
        error:
          json.error ||
          (playing
            ? `control HTTP ${res.status}`
            : "play returned but radio.playing is still false"),
        control_http: res.status,
        status_after: afterBody ?? after,
        probes_before: {
          control: ctrl,
          av: avHealth,
          status: avStatusBefore.body,
        },
        say: "Couldn't start the stream — short apology, no infrastructure lecture.",
      };
    }

    const ch =
      afterBody?.session?.channel || json.av?.channel || channel || "#test";

    return {
      ok: true,
      verified_playing: true,
      station: resolved.label,
      station_id: resolved.id,
      url: afterBody?.radio?.url || resolved.url,
      channel: ch,
      sessionId: afterBody?.session?.session_id || json.av?.sessionId,
      nick: afterBody?.session?.nick,
      say: `Streaming ${resolved.label} on freeq AV in ${ch} — join the voice call there to listen. stop_radio to stop.`,
    };
  },
});
