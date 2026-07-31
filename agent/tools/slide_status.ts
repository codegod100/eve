import { defineTool } from "eve/tools";
import { z } from "zod";

const CONTROL = process.env.IRC_CONTROL_URL ?? "http://127.0.0.1:8791";

export default defineTool({
  description:
    "Probe slide mode status (current question, awaiting answer, index). " +
    "Use for 'slide status', 'what slide are we on?', or before claiming slide mode is off.",
  inputSchema: z.object({}),
  async execute() {
    const res = await fetch(`${CONTROL}/slide/status`, {
      signal: AbortSignal.timeout(5_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      live?: boolean;
      state?: string;
      index?: number;
      total?: number;
      question?: string;
      awaiting?: boolean;
      channel?: string;
      error?: string;
    };
    if (!res.ok || json.ok === false) {
      return {
        ok: false,
        error: json.error || `control ${res.status}`,
        say: "Couldn't read slide status.",
      };
    }
    if (!json.live) {
      return {
        ok: true,
        live: false,
        state: json.state ?? "idle",
        say: "Slide mode is off. enter_slide_mode to start.",
      };
    }
    return {
      ok: true,
      live: true,
      state: json.state,
      channel: json.channel,
      index: json.index,
      total: json.total,
      awaiting: json.awaiting,
      question: json.question,
      say: json.awaiting
        ? `Slide ${(json.index ?? 0) + 1}/${json.total} waiting for an answer: ${json.question}`
        : `Slide mode live on ${json.channel} — ${(json.index ?? 0) + 1}/${json.total}.`,
    };
  },
});
