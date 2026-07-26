import { defineTool } from "eve/tools";
import { z } from "zod";

const CONTROL = process.env.IRC_CONTROL_URL ?? "http://127.0.0.1:8791";

export default defineTool({
  description:
    "Stop all freeq AV media: internet radio, stream.place watch, and stream.place publish. " +
    "Broader than stop_radio (radio only) or publish_stream stop (publish only). " +
    "Use when the user says stop media, stop all, stop everything, kill media, or silence all media.",
  inputSchema: z.object({
    reason: z.string().optional().describe("Optional note for logs."),
  }),
  async execute({ reason }) {
    const res = await fetch(`${CONTROL}/media/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      stopped?: boolean;
      wasPublishing?: boolean;
      message?: string;
    };
    if (!res.ok || json.ok === false) {
      return {
        ok: false,
        error: json.error || `control ${res.status}`,
        say: "Couldn't stop all media.",
      };
    }
    return {
      ok: true,
      stopped: true,
      wasPublishing: json.wasPublishing ?? null,
      message: json.message ?? "all media stopped",
      say: "Stopped all media (radio, stream.place watch, and publish).",
    };
  },
});
