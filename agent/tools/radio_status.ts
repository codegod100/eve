import { defineTool } from "eve/tools";
import { z } from "zod";

const CONTROL = process.env.IRC_CONTROL_URL ?? "http://127.0.0.1:8791";
const AV = process.env.AV_BRIDGE_URL ?? "http://127.0.0.1:8790";

async function get(url: string) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    const text = await res.text();
    try {
      return { ok: res.ok, status: res.status, body: JSON.parse(text) };
    } catch {
      return { ok: res.ok, status: res.status, body: text };
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export default defineTool({
  description:
    "Check whether freeq radio / AV media plane is up and if a stream is playing. " +
    "Use when user says they can't hear radio, or before claiming services are missing. " +
    "Returns live probe results only — never invent stack status.",
  inputSchema: z.object({}),
  async execute() {
    const [control, avHealth, avStatus] = await Promise.all([
      get(`${CONTROL}/health`),
      get(`${AV}/health`),
      get(`${AV}/v1/status`),
    ]);
    const st = avStatus.body as
      | {
          radio?: { playing?: boolean; url?: string; title?: string };
          session?: Record<string, unknown>;
        }
      | undefined;
    return {
      control_up: Boolean(control.ok),
      av_bridge_up: Boolean(avHealth.ok),
      radio_playing: Boolean(st?.radio?.playing),
      radio_url: st?.radio?.url ?? null,
      radio_title: st?.radio?.title ?? null,
      session: st?.session ?? null,
      control,
      av_health: avHealth,
      av_status: avStatus,
      say_if_playing:
        "Stream is up on the media plane — join freeq AV in the session channel to hear it.",
      say_if_down:
        "Something in the radio path is down (see control_up / av_bridge_up) — short note only.",
    };
  },
});
