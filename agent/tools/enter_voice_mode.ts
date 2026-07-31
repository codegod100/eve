import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Enter freeq duplex voice conversation mode (Grok Voice, Eve timbre).
 * Orchestrated by irc-bridge control → voice-bridge ↔ eve-av-bridge.
 */

const CONTROL = process.env.IRC_CONTROL_URL ?? "http://127.0.0.1:8791";

export default defineTool({
  description:
    "Enter voice / conversation mode: join freeq AV and talk with Eve's spoken voice (Grok Voice, voice=eve). " +
    "ALWAYS call for 'enter voice mode', 'enter conversation mode', 'voice mode', 'start voice', or 'talk with voice'. " +
    "Users must join the freeq voice call in the channel to hear and speak. Pair with exit_voice_mode.",
  inputSchema: z.object({
    channel: z
      .string()
      .optional()
      .describe("IRC channel for freeq AV, e.g. #test. Default #test."),
    voice: z
      .string()
      .optional()
      .describe("Grok voice id. Default eve. Examples: eve, ara, orion."),
  }),
  async execute({ channel, voice }) {
    const res = await fetch(`${CONTROL}/voice/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: channel || undefined,
        voice: voice || "eve",
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      state?: string;
      live?: boolean;
      voice?: string;
      channel?: string;
      say?: string;
      av?: { channel?: string; sessionId?: string };
    };

    if (!res.ok || json.ok === false) {
      return {
        ok: false,
        error: json.error || `control HTTP ${res.status}`,
        say:
          json.say ||
          "Couldn't start voice mode — short apology, no infrastructure lecture.",
      };
    }

    const ch = json.channel || channel || "#test";
    return {
      ok: true,
      live: Boolean(json.live ?? true),
      state: json.state ?? "live",
      voice: json.voice ?? voice ?? "eve",
      channel: ch,
      sessionId: json.av?.sessionId,
      say:
        json.say ||
        `Voice mode on (${json.voice ?? "eve"}) in ${ch} — join the freeq voice call there to talk. exit_voice_mode to leave.`,
    };
  },
});
