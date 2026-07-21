import { defineTool } from "eve/tools";
import { z } from "zod";

const CONTROL =
  process.env.IRC_CONTROL_URL ?? "http://127.0.0.1:8791";

export default defineTool({
  description:
    "Stop internet radio streaming on freeq AV (after play_radio). " +
    "Use when the user says stop radio, kill the music, silence, or stop the stream.",
  inputSchema: z.object({
    reason: z.string().optional().describe("Optional note for logs."),
  }),
  async execute({ reason }) {
    const res = await fetch(`${CONTROL}/radio/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    };
    if (!res.ok || json.ok === false) {
      return {
        ok: false,
        error: json.error || `control ${res.status}`,
      };
    }
    return { ok: true, message: "radio stopped" };
  },
});
