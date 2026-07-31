import { defineTool } from "eve/tools";
import { z } from "zod";

const CONTROL = process.env.IRC_CONTROL_URL ?? "http://127.0.0.1:8791";

export default defineTool({
  description:
    "Exit slide mode and stop the quiz loop. Use for 'exit slide mode', 'stop slide mode', 'end slides'.",
  inputSchema: z.object({
    reason: z.string().optional(),
  }),
  async execute({ reason }) {
    const res = await fetch(`${CONTROL}/slide/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      say?: string;
    };
    if (!res.ok || json.ok === false) {
      return {
        ok: false,
        error: json.error || `control ${res.status}`,
        say: "Couldn't exit slide mode.",
      };
    }
    return {
      ok: true,
      live: false,
      say: json.say || "Slide mode off.",
    };
  },
});
