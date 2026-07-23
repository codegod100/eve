import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Publish freeq call (or a media URL) to stream.place via RTMP.
 * Default mode=call mixes the whole freeq AV room through av-bridge call-egress.
 */

const CONTROL = process.env.IRC_CONTROL_URL ?? "http://127.0.0.1:8791";

export default defineTool({
  description:
    "Go live on stream.place. Default: rebroadcast the entire freeq AV call " +
    "(all remote participants mixed to one grid + audio) via RTMP. " +
    "Inverse of watch_stream. Use for go live, publish freeq to stream.place, " +
    "broadcast the call. Optional url modes push a single media URL instead. " +
    "Needs STREAMPLACE_STREAM_KEY on the irc-bridge and av-bridge with call-egress.",
  inputSchema: z.object({
    url: z
      .string()
      .optional()
      .describe(
        "Only for mode audio/av: media URL to push. Omit for freeq call mix.",
      ),
    title: z.string().optional().describe("Short title for notices/status."),
    mode: z
      .enum(["call", "audio", "av"])
      .optional()
      .describe(
        "call (default): mix freeq room. audio/av: ffmpeg a single URL to RTMP.",
      ),
    channel: z
      .string()
      .optional()
      .describe("IRC/AV channel, e.g. #test."),
    stop: z
      .boolean()
      .optional()
      .describe("If true, stop publishing instead of starting."),
  }),
  async execute({ url, title, mode, channel, stop }) {
    if (stop) {
      const res = await fetch(`${CONTROL}/streamplace/publish/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        wasPublishing?: boolean;
      };
      if (!res.ok || json.ok === false) {
        return {
          ok: false,
          error: json.error || `publish stop HTTP ${res.status}`,
          say: "Couldn't stop stream.place publish.",
        };
      }
      return {
        ok: true,
        stopped: true,
        wasPublishing: json.wasPublishing ?? null,
        say: json.wasPublishing
          ? "Stopped freeq → stream.place publish."
          : "stream.place publish was not running.",
      };
    }

    const res = await fetch(`${CONTROL}/streamplace/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: url || undefined,
        title: title || undefined,
        mode: mode || (url ? "audio" : "call"),
        channel: channel || undefined,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      sourceUrl?: string;
      title?: string;
      mode?: string;
      publicUrl?: string | null;
      channel?: string;
      pid?: number;
      rtmp?: string;
      call_egress?: { participants?: number; running?: boolean };
    };

    if (!res.ok || json.ok === false) {
      return {
        ok: false,
        error: json.error || `publish HTTP ${res.status}`,
        say:
          "Couldn't go live — need STREAMPLACE_STREAM_KEY, freeq SASL, av-bridge call-egress, and people in the freeq call.",
      };
    }

    const pub = json.publicUrl ? ` Watch: ${json.publicUrl}.` : "";
    const parts =
      json.call_egress?.participants != null
        ? ` (${json.call_egress.participants} remote tiles in mix)`
        : "";
    return {
      ok: true,
      sourceUrl: json.sourceUrl,
      title: json.title,
      mode: json.mode,
      publicUrl: json.publicUrl ?? null,
      channel: json.channel,
      pid: json.pid,
      rtmp: json.rtmp,
      call_egress: json.call_egress,
      say:
        json.mode === "call"
          ? `Now rebroadcasting freeq AV call${parts} to stream.place.${pub} Join freeq voice in ${json.channel || channel || "#test"} so tiles appear. Announce on stream.place dashboard.`
          : `Now publishing to stream.place (${json.mode}): ${json.title ?? json.sourceUrl}.${pub}`,
    };
  },
});
