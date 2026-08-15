import { defineChannel, GET, POST } from "eve/channels";

/**
 * Serve AT Protocol handle verification for eve.boxd.sh.
 * https://atproto.com/specs/handle#handle-resolution
 *
 * DID can be overridden with ATPROTO_DID (set by prep from rook identity).
 */
const tasks = new Map<string, any>();
// Absolute event count already consumed per session's durable stream.
// getEventStream() with no startIndex replays from event 0 every time, so
// without this a follow-up message on the same A2A contextId would re-read
// the prior turn's events first and return its stale answer again.
const cursors = new Map<string, number>();

const DID =
  process.env.ATPROTO_DID?.trim() ||
  "did:plc:fdiivi2izdgx3rl2d4qedt7n";

export default defineChannel({
  routes: [
    GET("/.well-known/:name", async () => Response.json({ name: "Eve", description: "Eve A2A agent", url: "https://eve.boxd.sh", version: "1.0.0", capabilities: { streaming: false, pushNotifications: false }, defaultInputModes: ["text"], defaultOutputModes: ["text"] })),
    POST("/message:send", async (req, { send, waitUntil }) => {
      const body: any = await req.json();
      const message = body?.message;
      const text = (message?.parts ?? []).map((part: any) => part?.text ?? "").join("").trim();
      if (message?.role !== "user" && message?.role !== "ROLE_USER" || !text) return Response.json({ error: "user text required" }, { status: 400 });
      const session = await send(text, { auth: null, title: "A2A conversation", continuationToken: message.contextId });
      const task: any = { id: session.id, contextId: message.contextId ?? session.id, status: { state: "working" }, history: [message] };
      tasks.set(session.id, task);
      let answer = "";
      // Applies one event to `task`/`answer`. Returns true once a terminal
      // event lands, so the reader can stop — the event stream is durable
      // per-session and does NOT close when a turn finishes, so waiting on
      // stream end (reader done) instead of a terminal event hangs forever.
      const applyEvent = (event: any): boolean => {
        const data = event?.data ?? {};
        if (event?.type === "message.appended") answer = data.messageDelta ?? data.text ?? answer;
        if (event?.type === "message.completed" && data.finishReason !== "tool-calls") answer = data.message ?? answer;
        if (event?.type === "session.waiting" || event?.type === "turn.completed") {
          task.status = { state: "completed" };
          if (answer) task.artifacts = [{ artifactId: `${task.id}-artifact`, parts: [{ kind: "text", text: answer }] }];
          return true;
        }
        if (event?.type === "turn.failed" || event?.type === "session.failed") {
          task.status = { state: "failed", message: { role: "ROLE_AGENT", parts: [{ kind: "text", text: String(data.message ?? "turn failed") }] } };
          return true;
        }
        return false;
      };
      const startIndex = cursors.get(session.id) ?? 0;
      let consumed = 0;
      const run = (async () => {
        try {
          const stream = await session.getEventStream({ startIndex });
          const reader = stream.getReader(); const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const next = await reader.read(); if (next.done) break;
            const chunk: any = next.value;
            if (chunk && typeof chunk === "object" && !(chunk instanceof ArrayBuffer) && !ArrayBuffer.isView(chunk)) {
              consumed++;
              if (applyEvent(chunk)) { reader.releaseLock(); cursors.set(session.id, startIndex + consumed); return; }
              continue;
            }
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                consumed++;
                if (applyEvent(JSON.parse(line))) { reader.releaseLock(); cursors.set(session.id, startIndex + consumed); return; }
              } catch { /* tolerate fragmented events */ }
            }
          }
          cursors.set(session.id, startIndex + consumed);
        } catch (error) { task.status = { state: "failed", message: { role: "ROLE_AGENT", parts: [{ kind: "text", text: String(error) }] } }; }
      })();
      // Block for the reply since the A2A card declares streaming:false —
      // Orchestral expects message:send itself to carry the final text, not
      // a "working" placeholder to poll later. Bounded by a timeout so a
      // stuck turn can't hang the request; falls back to background
      // completion (pollable via GET /tasks/:id) if that timeout fires.
      let timedOut = false;
      const timeout = new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, 25_000));
      await Promise.race([run, timeout]);
      if (timedOut) waitUntil(run);
      return Response.json({ task });
    }),
    GET("/tasks/:id", async (_req, { params }) => { const task = tasks.get(params.id); return task ? Response.json({ task }) : Response.json({ error: "task not found" }, { status: 404 }); }),
    GET("/.well-known/atproto-did", async () => {
      return new Response(`${DID}\n`, {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }),
  ],
});
