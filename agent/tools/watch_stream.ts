import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Flip freeq AV to a stream.place live stream (MoQ plane via irc-bridge).
 */

const CONTROL = process.env.IRC_CONTROL_URL ?? "http://127.0.0.1:8791";

export default defineTool({
  description:
    "Watch / switch to a stream.place live stream on freeq AV. " +
    "Use when the user says watch, switch stream, put on stream.place, " +
    "or pastes a stream.place URL/handle. Prefer this over play_radio for stream.place. " +
    "After ok:true tell user to join freeq voice in that channel.",
  inputSchema: z.object({
    streamer: z
      .string()
      .describe(
        "stream.place URL (https://stream.place/handle), handle (iame.li), or did:plc:…",
      ),
    channel: z
      .string()
      .optional()
      .describe("IRC channel for AV, e.g. #test. Default from bridge."),
  }),
  async execute({ streamer, channel }) {
    const res = await fetch(`${CONTROL}/streamplace/play`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        streamer,
        channel: channel || undefined,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      stream?: {
        handle?: string;
        did?: string;
        title?: string;
        viewers?: number | null;
        url?: string;
      };
      av?: { channel?: string; sessionId?: string };
      plane?: string;
    };

    if (!res.ok || json.ok === false) {
      return {
        ok: false,
        error: json.error || `streamplace play HTTP ${res.status}`,
        say: "Couldn't switch the stream — short apology.",
      };
    }

    const handle = json.stream?.handle ?? streamer;
    const title = json.stream?.title ?? handle;
    const ch = json.av?.channel || channel || "#test";
    const viewers =
      json.stream?.viewers != null ? `${json.stream.viewers} watching` : "live";

    return {
      ok: true,
      handle,
      title,
      viewers: json.stream?.viewers ?? null,
      url: json.stream?.url ?? `https://stream.place/${handle}`,
      channel: ch,
      sessionId: json.av?.sessionId,
      plane: json.plane,
      say: `Now watching ${title} (@${handle}, ${viewers}) on freeq AV in ${ch} — join voice there.`,
    };
  },
});
