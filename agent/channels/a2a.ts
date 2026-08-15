import { defineChannel, GET, POST } from "eve/channels";

/**
 * A small A2A (Agent-to-Agent) JSON-RPC adapter.  A2A deliberately lives in a
 * channel rather than in the model runtime: tasks are backed by normal eve
 * sessions, so they retain eve's tools, auth and durable history.
 */
type Part = { kind?: string; text?: string };
type A2AMessage = { messageId?: string; role?: string; parts?: Part[]; contextId?: string; taskId?: string };
type Task = {
  id: string;
  contextId: string;
  status: { state: string; message?: A2AMessage; timestamp?: string };
  artifacts?: Array<{ artifactId: string; parts: Part[] }>;
  history: A2AMessage[];
};

const tasks = new Map<string, Task>();
const continuations = new Map<string, string>();
const publicName = process.env.A2A_AGENT_NAME ?? "eve";
const publicDescription = process.env.A2A_AGENT_DESCRIPTION ?? "An eve agent";

function textOf(message: A2AMessage): string {
  return (message.parts ?? [])
    .filter((part) => part.kind === undefined || part.kind === "text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

function rpc(id: unknown, result: unknown) {
  return Response.json({ jsonrpc: "2.0", id, result });
}
function error(id: unknown, code: number, message: string) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status: 400 });
}
function now() { return new Date().toISOString(); }

async function runTask(task: Task, input: A2AMessage, send: (message: string, options: Record<string, unknown>) => Promise<any>, waitUntil: (promise: Promise<unknown>) => void) {
  try {
    const continuationToken = continuations.get(task.contextId);
    const session = await send(textOf(input), {
      auth: null,
      ...(continuationToken ? { continuationToken } : {}),
      title: `a2a: ${task.contextId}`,
    });
    // Keep the stream reader in the background.  This also avoids making A2A
    // callers hold an HTTP request open while a model is running.
    waitUntil((async () => {
      const stream = await session.getEventStream();
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: any;
          try { event = JSON.parse(line); } catch { continue; }
          const data = event.data ?? {};
          if (event.type === "message.appended") answer = data.text ?? data.messageDelta ?? answer;
          if (event.type === "message.completed" && typeof data.message === "string") answer = data.message;
          if (event.type === "session.waiting") {
            if (typeof data.continuationToken === "string") continuations.set(task.contextId, data.continuationToken);
            task.status = { state: "completed", timestamp: now() };
            if (answer) task.artifacts = [{ artifactId: `${task.id}-artifact`, parts: [{ kind: "text", text: answer }] }];
            return;
          }
          if (event.type === "turn.failed" || event.type === "session.failed") {
            task.status = { state: "failed", message: { role: "agent", parts: [{ kind: "text", text: String(data.message ?? data.details?.message ?? "turn failed") }] }, timestamp: now() };
            return;
          }
        }
      }
      task.status = { state: "completed", timestamp: now() };
      if (answer) task.artifacts = [{ artifactId: `${task.id}-artifact`, parts: [{ kind: "text", text: answer }] }];
    })());
  } catch (cause) {
    task.status = { state: "failed", message: { role: "agent", parts: [{ kind: "text", text: cause instanceof Error ? cause.message : String(cause) }] }, timestamp: now() };
  }
}

async function handle(req: Request, args: any) {
  let body: any;
  try { body = await req.json(); } catch { return error(null, -32700, "Invalid JSON"); }
  const id = body?.id ?? null;
  if (body?.jsonrpc !== "2.0" || typeof body?.method !== "string") return error(id, -32600, "Invalid Request");
  if (body.method === "tasks/get") {
    const task = tasks.get(body.params?.id);
    return task ? rpc(id, task) : error(id, -32001, "Task not found");
  }
  if (body.method !== "message/send" && body.method !== "tasks/send") return error(id, -32601, "Method not found");
  const input: A2AMessage = body.params?.message ?? body.params?.task?.message;
  if (!input || input.role !== "user" || !textOf(input)) return error(id, -32602, "A user text message is required");
  const contextId = input.contextId ?? body.params?.contextId ?? crypto.randomUUID();
  const taskId = input.taskId ?? body.params?.taskId ?? crypto.randomUUID();
  const task: Task = tasks.get(taskId) ?? { id: taskId, contextId, status: { state: "submitted", timestamp: now() }, history: [] };
  task.history.push(input);
  tasks.set(taskId, task);
  args.waitUntil(runTask(task, input, args.send, args.waitUntil));
  return rpc(id, task);
}

export default defineChannel({
  routes: [
    GET("/.well-known/agent-card.json", async (req) => {
      const base = process.env.A2A_PUBLIC_URL ?? new URL(req.url).origin;
      return Response.json({ name: publicName, description: publicDescription, version: "1.0.0", url: `${base}/eve/v1/a2a`, protocolVersion: "0.3.0", capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true }, defaultInputModes: ["text"], defaultOutputModes: ["text"], skills: [] });
    }),
    POST("/", handle),
    POST("/a2a", handle),
  ],
});
