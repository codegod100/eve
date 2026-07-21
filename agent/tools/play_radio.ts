import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Start streaming internet radio into the freeq AV call on a channel.
 * Orchestrated by irc-bridge control → eve-av-bridge → ffmpeg → MoQ.
 */

const CONTROL = process.env.IRC_CONTROL_URL ?? "http://127.0.0.1:8791";
const AV = process.env.AV_BRIDGE_URL ?? "http://127.0.0.1:8790";

const STATIONS: Record<string, { url: string; label: string }> = {
  groove: {
    label: "SomaFM Groove Salad",
    url: "https://ice1.somafm.com/groovesalad-128-mp3",
  },
  groovesalad: {
    label: "SomaFM Groove Salad",
    url: "https://ice1.somafm.com/groovesalad-128-mp3",
  },
  drone: {
    label: "SomaFM Drone Zone",
    url: "https://ice1.somafm.com/dronezone-128-mp3",
  },
  dronezone: {
    label: "SomaFM Drone Zone",
    url: "https://ice1.somafm.com/dronezone-128-mp3",
  },
  beatblender: {
    label: "SomaFM Beat Blender",
    url: "https://ice1.somafm.com/beatblender-128-mp3",
  },
  defcon: {
    label: "SomaFM DEF CON Radio",
    url: "https://ice1.somafm.com/defcon-128-mp3",
  },
  deepspace: {
    label: "SomaFM Deep Space One",
    url: "https://ice1.somafm.com/deepspaceone-128-mp3",
  },
  indie: {
    label: "SomaFM Indie Pop Rocks",
    url: "https://ice1.somafm.com/indiepop-128-mp3",
  },
  metal: {
    label: "SomaFM Metal Detector",
    url: "https://ice1.somafm.com/metal-128-mp3",
  },
  radio: {
    label: "SomaFM Groove Salad",
    url: "https://ice1.somafm.com/groovesalad-128-mp3",
  },
};

function resolveStation(input: string | undefined): {
  url: string;
  label: string;
} {
  if (!input || !input.trim()) return STATIONS.radio;
  const raw = input.trim();
  if (/^https?:\/\//i.test(raw)) {
    return { url: raw, label: raw };
  }
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (STATIONS[key]) return STATIONS[key];
  for (const [k, v] of Object.entries(STATIONS)) {
    if (
      raw.toLowerCase().includes(k) ||
      v.label.toLowerCase().includes(raw.toLowerCase())
    ) {
      return v;
    }
  }
  return STATIONS.radio;
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

export default defineTool({
  description:
    "Play internet radio into the freeq AV call (default #test). " +
    "Use for play radio / stream music / station names (groove, drone, …) or stream URL. " +
    "ALWAYS call this tool for radio requests — never invent whether services are installed. " +
    "Pair with stop_radio. After ok:true tell user to join freeq voice in that channel.",
  inputSchema: z.object({
    station: z
      .string()
      .optional()
      .describe(
        "Station (groove, drone, beatblender, defcon, deepspace, indie, metal) or http(s) URL. Default groove.",
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
      url: afterBody?.radio?.url || resolved.url,
      channel: ch,
      sessionId: afterBody?.session?.session_id || json.av?.sessionId,
      nick: afterBody?.session?.nick,
      say: `Streaming ${resolved.label} on freeq AV in ${ch} — join the voice call there to listen. stop_radio to stop.`,
    };
  },
});
