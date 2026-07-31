import { defineTool } from "eve/tools";
import { z } from "zod";

const CONTROL = process.env.IRC_CONTROL_URL ?? "http://127.0.0.1:8791";

export default defineTool({
  description:
    "Start freeform AV caption card: user says something, Eve shows it on the freeq slide tile only (no TTS). " +
    "ALWAYS call for 'enter slide mode', 'echo test', 'start echo', or 'av echo'. " +
    "Pair with exit_slide_mode.",
  inputSchema: z.object({
    channel: z
      .string()
      .optional()
      .describe("IRC channel, e.g. #test. Default #test."),
    with_voice: z
      .boolean()
      .optional()
      .describe(
        "Listen with STT for spoken captions (default true when AV is up). Does not speak back.",
      ),
  }),
  async execute({ channel, with_voice }) {
    const res = await fetch(`${CONTROL}/slide/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: channel || undefined,
        withVoice: with_voice,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      live?: boolean;
      channel?: string;
      say?: string;
    };
    if (!res.ok || json.ok === false) {
      return {
        ok: false,
        error: json.error || `control HTTP ${res.status}`,
        say: json.say || "Couldn't start slide captions.",
      };
    }
    return {
      ok: true,
      live: Boolean(json.live ?? true),
      mode: "echo",
      channel: json.channel || channel || "#test",
      say:
        json.say ||
        "Slide captions on — join freeq AV, say something; I show it on the card (no voice echo).",
    };
  },
});
