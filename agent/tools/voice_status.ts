import { defineTool } from "eve/tools";
import { z } from "zod";

const CONTROL = process.env.IRC_CONTROL_URL ?? "http://127.0.0.1:8791";
const AV = process.env.AV_BRIDGE_URL ?? "http://127.0.0.1:8790";

export default defineTool({
  description:
    "Probe voice / conversation mode status (Grok Voice duplex + freeq AV). " +
    "Use when the user asks if voice mode is on, can't hear Eve speak, or before claiming voice is missing.",
  inputSchema: z.object({}),
  async execute() {
    const [ctrl, voice, av] = await Promise.all([
      fetch(`${CONTROL}/health`, { signal: AbortSignal.timeout(3_000) })
        .then(async (r) => ({
          ok: r.ok,
          status: r.status,
          body: await r.json().catch(() => null),
        }))
        .catch((e) => ({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        })),
      fetch(`${CONTROL}/voice/status`, { signal: AbortSignal.timeout(3_000) })
        .then(async (r) => ({
          ok: r.ok,
          status: r.status,
          body: await r.json().catch(() => null),
        }))
        .catch((e) => ({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        })),
      fetch(`${AV}/v1/status`, { signal: AbortSignal.timeout(3_000) })
        .then(async (r) => ({
          ok: r.ok,
          status: r.status,
          body: await r.json().catch(() => null),
        }))
        .catch((e) => ({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        })),
    ]);

    const v = (voice as { body?: { live?: boolean; state?: string; voice?: string; channel?: string; lastError?: string } }).body;
    const live = Boolean(v?.live);
    return {
      ok: true,
      control_up: Boolean((ctrl as { ok?: boolean }).ok),
      av_bridge_up: Boolean((av as { ok?: boolean }).ok),
      voice_live: live,
      voice_state: v?.state ?? "unknown",
      voice: v?.voice ?? null,
      channel: v?.channel ?? null,
      last_error: v?.lastError ?? null,
      av_session: (av as { body?: { session?: unknown } }).body?.session ?? null,
      say: live
        ? `Voice mode live (${v?.voice ?? "eve"}) on ${v?.channel ?? "#test"} — join freeq AV to talk.`
        : `Voice mode is off (state=${v?.state ?? "idle"}). enter_voice_mode to start.`,
    };
  },
});
