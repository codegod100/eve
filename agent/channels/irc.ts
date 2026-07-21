import { defineChannel, GET, POST } from "eve/channels";

/**
 * Thin IRC channel for eve — no IRC socket here.
 *
 * Architecture (see irc-bridge/):
 *   freeq ←TLS→ irc-bridge ─POST /irc/inbound→ eve
 *                         ←SSE  /irc/out────── eve
 *
 * The bridge owns the IRC connection. This channel only:
 *   1) accepts inbound POSTs and starts agent turns
 *   2) streams completed replies to the bridge via SSE
 *   3) supports schedule → receive() into #channel
 */

type IrcState = {
  from: string | null;
  target: string | null;
};

type Outbound = {
  type: "privmsg";
  target: string;
  text: string;
};

type SseClient = {
  id: number;
  write: (chunk: string) => void;
  close: () => void;
};

const GLOBAL_SSE_KEY = Symbol.for("eve.agent.irc.sse.clients");

type SseBag = {
  clients: Map<number, SseClient>;
  nextId: number;
};

function sseBag(): SseBag {
  const g = globalThis as typeof globalThis & { [GLOBAL_SSE_KEY]?: SseBag };
  if (!g[GLOBAL_SSE_KEY]) {
    g[GLOBAL_SSE_KEY] = { clients: new Map(), nextId: 1 };
  }
  return g[GLOBAL_SSE_KEY];
}

function broadcastPrivmsg(target: string, text: string) {
  const payload: Outbound = { type: "privmsg", target, text };
  const data = `event: privmsg\ndata: ${JSON.stringify(payload)}\n\n`;
  const bag = sseBag();
  for (const [id, c] of bag.clients) {
    try {
      c.write(data);
    } catch {
      bag.clients.delete(id);
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
  }
}

function isHookConflict(msg: string): boolean {
  return /already in use|HookConflict/i.test(msg);
}

const IRC_CHANNEL = process.env.IRC_CHANNEL ?? "#test";

export type IrcReceiveTarget = {
  channel?: string;
};

export default defineChannel<IrcState, { state: IrcState }, IrcReceiveTarget>({
  state: { from: null, target: null },

  context(state) {
    return { state };
  },

  metadata(state) {
    return { from: state.from, target: state.target };
  },

  async receive(input, { send }) {
    const channel =
      (typeof input.target?.channel === "string" &&
        input.target.channel.trim()) ||
      IRC_CHANNEL;
    return send(input.message, {
      auth: input.auth,
      continuationToken: `schedule:${channel}`,
      state: { from: "schedule", target: channel },
      title: `irc schedule → ${channel}`,
    });
  },

  routes: [
    // Bridge → eve: user message from IRC
    POST("/irc/inbound", async (req, { send }) => {
      const body = (await req.json()) as {
        from: string;
        target: string;
        text: string;
      };
      try {
        // Delivery message = the mention only (prefixed with speaker nick so
        // the model knows who to address). Do NOT pass SendPayload.context:
        // eve injects those as role:user history and models answer every line
        // (old mentions, rejoin scrollback, etc.).
        const nick = String(body.from ?? "").trim() || "someone";
        await send(`<${nick}> ${body.text}`, {
          auth: {
            authenticator: "irc",
            principalType: "user",
            principalId: body.from,
            attributes: { target: body.target },
          },
          // Per-message token so a stuck prior turn does not block the next.
          continuationToken: `${body.from}:${Date.now()}`,
          state: { from: body.from, target: body.target },
          title: `irc: ${body.from}`,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const target = body.target || IRC_CHANNEL;
        if (isHookConflict(msg)) {
          broadcastPrivmsg(
            target,
            `${body.from}: still thinking about your last message — try again in a moment.`,
          );
        } else {
          broadcastPrivmsg(target, `[error] ${msg.slice(0, 200)}`);
        }
      }
      // Return immediately after the turn is accepted/finished so the bridge
      // is not tied to model latency (replies already go out on SSE).
      return new Response("ok");
    }),

    // Bridge ← eve: long-lived SSE of outbound PRIVMSGs
    GET("/irc/out", async () => {
      const bag = sseBag();
      const id = bag.nextId++;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          const write = (chunk: string) => {
            controller.enqueue(enc.encode(chunk));
          };
          const close = () => {
            try {
              controller.close();
            } catch {
              /* ignore */
            }
          };
          bag.clients.set(id, { id, write, close });
          // hello + keepalives
          write(
            `event: hello\ndata: ${JSON.stringify({
              type: "hello",
              channel: IRC_CHANNEL,
              clients: bag.clients.size,
            })}\n\n`,
          );
          const ping = setInterval(() => {
            try {
              write(`: ping ${Date.now()}\n\n`);
            } catch {
              clearInterval(ping);
            }
          }, 15_000);
          // store ping on client for cleanup via close wrapper
          const origClose = close;
          bag.clients.set(id, {
            id,
            write,
            close: () => {
              clearInterval(ping);
              origClose();
            },
          });
        },
        cancel() {
          const c = bag.clients.get(id);
          bag.clients.delete(id);
          c?.close();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    }),
  ],

  events: {
    "message.completed"(data, channel) {
      let text = data.message;
      if (!text) return;
      const target = channel.state.target ?? channel.state.from ?? IRC_CHANNEL;
      if (!target) return;
      // IRC highlight: ensure user replies start with "nick: …"
      // (model is also instructed to do this; this is the hard guarantee).
      const from = channel.state.from;
      if (from && from !== "schedule") {
        const stripped = text.replace(/^\s+/, "");
        const prefix = `${from}:`;
        if (!stripped.toLowerCase().startsWith(prefix.toLowerCase())) {
          text = `${from}: ${stripped}`;
        } else {
          text = stripped;
        }
      }
      broadcastPrivmsg(target, text);
    },
    "turn.failed"(data, channel) {
      const target = channel.state.target ?? channel.state.from ?? IRC_CHANNEL;
      if (!target) return;
      const msg = data.details?.message ?? data.message ?? "turn failed";
      if (isHookConflict(String(msg))) {
        broadcastPrivmsg(
          target,
          `${channel.state.from ?? "you"}: still thinking about your last message — try again in a moment.`,
        );
        return;
      }
      broadcastPrivmsg(target, `[error] ${String(msg).slice(0, 300)}`);
    },
    "session.failed"(data, channel) {
      const target = channel.state.target ?? channel.state.from ?? IRC_CHANNEL;
      if (!target) return;
      const msg = data.details?.message ?? data.message ?? "session failed";
      if (isHookConflict(String(msg))) {
        broadcastPrivmsg(
          target,
          `${channel.state.from ?? "you"}: still thinking about your last message — try again in a moment.`,
        );
        return;
      }
      broadcastPrivmsg(target, `[error] ${String(msg).slice(0, 300)}`);
    },
  },
});
