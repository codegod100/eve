import { defineChannel, GET, POST } from "eve/channels";

/**
 * Serve AT Protocol handle verification for eve.boxd.sh.
 * https://atproto.com/specs/handle#handle-resolution
 *
 * DID can be overridden with ATPROTO_DID (set by prep from rook identity).
 */
const DID =
  process.env.ATPROTO_DID?.trim() ||
  "did:plc:fdiivi2izdgx3rl2d4qedt7n";

export default defineChannel({
  routes: [
    GET("/.well-known/:name", async () => Response.json({ name: "Eve", description: "Eve A2A agent", url: "https://eve.boxd.sh", version: "1.0.0", capabilities: { streaming: false, pushNotifications: false }, defaultInputModes: ["text"], defaultOutputModes: ["text"] })),
    POST("/message:send", async (req, { send }) => {
      const body: any = await req.json();
      const message = body?.message;
      const text = (message?.parts ?? []).map((part: any) => part?.text ?? "").join("").trim();
      if (message?.role !== "user" || !text) return Response.json({ error: "user text required" }, { status: 400 });
      const session = await send(text, { title: "A2A conversation" });
      const stream = await session.getEventStream();
      const reader = stream.getReader(); const decoder = new TextDecoder();
      let answer = ""; let buffer = "";
      while (true) {
        const next = await reader.read(); if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const line of lines) { try {
          const event: any = JSON.parse(line); const data = event.data ?? {};
          if (typeof data.messageDelta === "string") answer += data.messageDelta;
          if (event.type === "message.completed" && typeof data.message === "string") answer = data.message;
        } catch { /* partial event */ } }
      }
      return Response.json({ task: { id: session.id, contextId: message.contextId ?? session.id, status: { state: "completed" }, artifacts: [{ artifactId: `${session.id}-artifact`, parts: [{ kind: "text", text: answer || "(no response)" }] }] } });
    }),
    POST("/message:send", async (req, { send }) => {
      const body: any = await req.json();
      const text = (body?.message?.parts ?? []).map((part: any) => part?.text ?? "").join("").trim();
      if (body?.message?.role !== "user" || !text) return Response.json({ error: "user text required" }, { status: 400 });
      const session = await send(text, { auth: null, continuationToken: body.message.contextId, title: "A2A conversation" });
      return Response.json({ task: { id: session.id, contextId: body.message.contextId ?? session.id, status: { state: "submitted" } } });
    }),
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
