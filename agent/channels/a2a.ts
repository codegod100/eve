import { defineChannel, GET, POST } from "eve/channels";

const card = {
  name: "Eve",
  description: "Eve assistant on boxd",
  url: "https://eve.boxd.sh",
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{ id: "chat", name: "Chat", description: "Chat with Eve", tags: ["conversation"] }],
};

function textFromMessage(message: any): string {
  return (message?.parts ?? []).map((p: any) => p?.text ?? "").filter(Boolean).join("\n");
}

async function collectText(session: any): Promise<string> {
  const stream = await session.getEventStream();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          const delta = event?.data?.messageDelta ?? event?.data?.text ?? event?.messageDelta;
          if (typeof delta === "string") result += delta;
          const completed = event?.data?.message ?? event?.message;
          if (!result && typeof completed === "string") result = completed;
        } catch { /* stream chunks may split JSON lines */ }
      }
    }
  } finally { reader.releaseLock(); }
  return result || "(no response)";
}

export default defineChannel({
  routes: [
    GET("/.well-known/agent-card.json", async () => Response.json(card)),
    POST("/message:send", async (req, { send }) => {
      const body: any = await req.json();
      const message = textFromMessage(body.message);
      if (!message) return Response.json({ error: { code: -32602, message: "message text required" } }, { status: 400 });
      const session = await send(message, {
        auth: null,
        continuationToken: body.message?.contextId,
        title: "A2A conversation",
      });
      const responseText = await collectText(session);
      return Response.json({
        task: {
          id: session.id,
          contextId: body.message?.contextId ?? session.id,
          status: { state: "completed" },
          artifacts: [{ parts: [{ kind: "text", text: responseText }] }],
        },
      });
    }),
  ],
});
