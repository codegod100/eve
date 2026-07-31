import { defineTool } from "eve/tools";
import { z } from "zod";

const CONTROL = process.env.IRC_CONTROL_URL ?? "http://127.0.0.1:8791";

export default defineTool({
  description:
    "Exit voice / conversation mode and stop the Grok Voice duplex session. " +
    "Use for 'exit voice mode', 'leave voice mode', 'stop voice', 'end conversation mode'. " +
    "Does not tear down freeq AV unless stop_media is also used.",
  inputSchema: z.object({
    reason: z.string().optional().describe("Optional note for logs."),
  }),
  async execute({ reason }) {
    const res = await fetch(`${CONTROL}/voice/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      state?: string;
      live?: boolean;
      say?: string;
    };
    if (!res.ok || json.ok === false) {
      return {
        ok: false,
        error: json.error || `control ${res.status}`,
        say: "Couldn't exit voice mode.",
      };
    }
    return {
      ok: true,
      live: false,
      state: json.state ?? "idle",
      say: json.say || "Voice mode off.",
    };
  },
});
