import { defineChannel, GET, POST } from "eve/channels";

export default defineChannel({
  routes: [
    GET("/.well-known/agent-card.json", async (req) => Response.json({
      name: "Eve", description: "Eve A2A agent", version: "1.0.0",
      url: `${new URL(req.url).origin}/orchestral`, protocolVersion: "0.3.0",
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ["text"], defaultOutputModes: ["text"],
    })),
    POST("/message:send", async (req, { send }) => {
      const body: any = await req.json();
      const message = body?.message;
      const text = (message?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
      if (message?.role !== "user" || !text) return Response.json({ error: "user text required" }, { status: 400 });
      const session = await send(text, { auth: null, continuationToken: message.contextId, title: "A2A conversation" });
      return Response.json({ task: { id: session.id, contextId: message.contextId ?? session.id, status: { state: "submitted" } } });
    }),
  ],
});
