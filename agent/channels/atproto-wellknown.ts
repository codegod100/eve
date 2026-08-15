import { defineChannel, GET, POST } from "eve/channels";

/**
 * Serve AT Protocol handle verification for eve.boxd.sh.
 * https://atproto.com/specs/handle#handle-resolution
 *
 * DID can be overridden with ATPROTO_DID (set by prep from rook identity).
 */
const tasks = new Map<string, any>();

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
      if (message?.role !== "user" || !text) return Response.json({ error: "user text required" }, { status: 400 });
      const session = await send({ message: text }, { title: "A2A conversation", continuationToken: message.contextId });
      const task: any = { id: session.id, contextId: message.contextId ?? session.id, status: { state: "submitted" }, history: [message] };
      tasks.set(session.id, task);
      waitUntil((async () => {
        try {
          const stream = await session.getEventStream(); const reader = stream.getReader();
          const decoder = new TextDecoder(); let buffer = ""; let answer = "";
          while (true) {
            const next = await reader.read(); if (next.done) break;
            buffer += decoder.decode(next.value, { stream: true });
            const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
            for (const line of lines) { if (!line.trim()) continue; try {
              const event: any = JSON.parse(line); const data = event.data ?? {};
              if (event.type === "message.appended") answer += data.text ?? data.messageDelta ?? "";
              if (event.type === "message.completed" && typeof data.message === "string") answer = data.message;
              if (event.type === "turn.failed" || event.type === "session.failed") { task.status = { state: "failed", message: { role: "agent", parts: [{ kind: "text", text: String(data.message ?? "turn failed") }] } }; return; }
              if (event.type === "session.waiting") { task.status = { state: "completed" }; if (answer) task.artifacts = [{ artifactId: `${task.id}-artifact`, parts: [{ kind: "text", text: answer }] }]; return; }
            } catch { /* ignore partial event */ } }
          }
          task.status = { state: "completed" }; if (answer) task.artifacts = [{ artifactId: `${task.id}-artifact`, parts: [{ kind: "text", text: answer }] }];
        } catch (error) { task.status = { state: "failed", message: { role: "agent", parts: [{ kind: "text", text: String(error) }] } }; }
      })());
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
