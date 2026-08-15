import { defineChannel, GET, POST } from "eve/channels";

// A2A HTTP+JSON/REST binding used by Orchestral.
const publicUrl = () => process.env.A2A_PUBLIC_URL ?? "https://eve.boxd.sh";
const tasks = new Map<string, any>();

function textFromMessage(message: any): string {
  return (message?.parts ?? []).filter((p: any) => p?.kind === undefined || p.kind === "text")
    .map((p: any) => p?.text ?? "").join("\n").trim();
}

async function collectText(session: any): Promise<string> {
  const stream = await session.getEventStream();
  const reader = stream.getReader();
  const decoder = new TextDecoder(); let result = ""; let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
      for (const line of lines) { if (!line.trim()) continue;
        try { const e = JSON.parse(line); const d = e?.data ?? e;
          if (typeof d.messageDelta === "string") result += d.messageDelta;
          else if (e.type === "message.completed" && typeof d.message === "string") result = d.message;
          else if (typeof d.text === "string" && e.type === "message.appended") result += d.text;
        } catch { /* event may be split across chunks */ }
      }
    }
  } finally { reader.releaseLock(); }
  return result || "(no response)";
}

async function sendMessage(req: Request, { send }: any) {
  let body: any; try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const message = body?.message;
  const text = textFromMessage(message);
  if (!text || message?.role !== "user") return Response.json({ error: "a user text message is required" }, { status: 400 });
  const taskId = body?.id ?? crypto.randomUUID();
  const contextId = message.contextId ?? crypto.randomUUID();
  const session = await send(text, { auth: null, title: `a2a: ${contextId}` });
  const answer = await collectText(session);
  const task = { id: taskId, contextId, status: { state: "completed" }, history: [message], artifacts: [{ artifactId: `${taskId}-artifact`, parts: [{ kind: "text", text: answer }] }] };
  tasks.set(taskId, task);
  return Response.json({ task });
}

const card = () => ({ name: process.env.A2A_AGENT_NAME ?? "Eve", description: process.env.A2A_AGENT_DESCRIPTION ?? "An eve agent", version: "1.0.0", url: `${publicUrl()}/eve/v1/a2a`, protocolVersion: "0.3.0", capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true }, defaultInputModes: ["text"], defaultOutputModes: ["text"], skills: [{ id: "chat", name: "Chat", description: "Chat with Eve", tags: ["conversation"] }] });

export default defineChannel({ routes: [
  GET("/.well-known/agent-card.json", async () => Response.json(card())),
  POST("/message:send", sendMessage),
  POST("/message:stream", sendMessage),
  GET("/tasks/:id", async (_req: Request, args: any) => { const task = tasks.get(args.params?.id ?? args.id); return task ? Response.json({ task }) : Response.json({ error: "task not found" }, { status: 404 }); }),
] });
