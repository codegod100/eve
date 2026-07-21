import { defineChannel, POST } from "eve/channels";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import * as net from "node:net";
import * as tls from "node:tls";

// An IRC channel for eve. A minimal RFC 2812 client (raw TCP, no deps) stays
// connected for the life of the process. Inbound PRIVMSGs addressed to the bot
// are bridged into eve sessions via the channel's own /irc/inbound route; the
// agent's completed replies are sent back to IRC as PRIVMSG.
//
// Config (env, sourced at boot):
//   IRC_HOST, IRC_PORT (default 6697), IRC_NICK, IRC_CHANNEL,
//   IRC_PASSWORD (SASL PLAIN, optional), IRC_TLS ("0" to disable),
//   IRC_OWNERS (comma-separated nicks allowed to DM the bot).
//
// Liveness (optional env, sensible defaults):
//   IRC_WATCHDOG_MS     — how often to check the socket (default 30000)
//   IRC_PING_AFTER_MS   — send client PING if no RX for this long (default 60000)
//   IRC_DEAD_AFTER_MS   — force reconnect if no RX for this long (default 120000)
//   IRC_TCP_KEEPALIVE_MS — TCP keepalive initial delay (default 30000)
//
// Singleton: exactly one live IRC TCP/TLS socket per process. Module reloads
// (eve dev HMR), schedule imports of this channel, and reconnect races must not
// spawn additional connections.

type IrcState = {
  from: string | null;
  target: string | null;
};

type IrcCtx = {
  state: IrcState;
  irc: IrcClient;
};

// ---------------------------------------------------------------------------
// Minimal IRC client
// ---------------------------------------------------------------------------

type IrcLine = { command: string; params: string[]; prefix?: string };

function parseIrcLine(line: string): IrcLine {
  let prefix: string | undefined;
  let rest = line;
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  let trailing: string | undefined;
  const ti = rest.indexOf(" :");
  if (ti !== -1) {
    trailing = rest.slice(ti + 2);
    rest = rest.slice(0, ti);
  }
  const parts = rest.split(" ").filter(Boolean);
  const command = parts.shift() ?? "";
  const params = parts;
  if (trailing !== undefined) params.push(trailing);
  return { command, params, prefix };
}

function nickFromPrefix(prefix?: string): string {
  if (!prefix) return "";
  return prefix.split("!")[0];
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Defaults tuned for freeq-style servers: catch half-open sockets before the
// next user message fails with ECONNRESET, without reconnecting on quiet rooms.
const WATCHDOG_INTERVAL_MS = envMs("IRC_WATCHDOG_MS", 30_000);
const CLIENT_PING_AFTER_MS = envMs("IRC_PING_AFTER_MS", 60_000);
const DEAD_AFTER_MS = envMs("IRC_DEAD_AFTER_MS", 120_000);
const TCP_KEEPALIVE_MS = envMs("IRC_TCP_KEEPALIVE_MS", 30_000);

/** process-global key so HMR / multi-import share one client */
const GLOBAL_IRC_KEY = Symbol.for("eve.agent.irc.client");

type GlobalIrcBag = {
  client: IrcClient | null;
  signalHandlersBound: boolean;
};

function globalBag(): GlobalIrcBag {
  const g = globalThis as typeof globalThis & {
    [GLOBAL_IRC_KEY]?: GlobalIrcBag;
  };
  if (!g[GLOBAL_IRC_KEY]) {
    g[GLOBAL_IRC_KEY] = { client: null, signalHandlersBound: false };
  }
  return g[GLOBAL_IRC_KEY];
}

class IrcClient {
  private socket: Socket | null = null;
  private tlsSock: TLSSocket | null = null;
  private buf = "";
  private joined = false;
  private joinedAt = 0; // ms timestamp of our own JOIN echo; used to drop history backlog
  private stopped = false;
  private started = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  private watchdogTimer: ReturnType<typeof setInterval> | undefined = undefined;
  /** True while a connect attempt is open (until register-ready or failed). */
  private connecting = false;
  /**
   * Bumps on every intentional teardown / new connect. Close handlers from an
   * old generation must not schedule reconnects (that was spawning N sockets).
   */
  private generation = 0;
  private lastRxAt = 0;
  private lastPingAt = 0;
  /** Recent PRIVMSGs seen, used to drop duplicate deliveries from the server. */
  private recentMsgs: { key: string; at: number }[] = [];
  readonly host: string;
  readonly port: number;
  /** Preferred nick from config; re-attempted on every reconnect. */
  readonly preferredNick: string;
  /** Current nick (may gain a random suffix after 433). */
  nick: string;
  readonly channel: string;
  readonly password: string | undefined;
  readonly tls: boolean;
  readonly owners: Set<string>;
  onMessage: (from: string, target: string, text: string) => void;

  constructor(opts: {
    host: string;
    port: number;
    nick: string;
    channel: string;
    password?: string;
    tls?: boolean;
    owners?: string[];
    onMessage: (from: string, target: string, text: string) => void;
  }) {
    this.host = opts.host;
    this.port = opts.port;
    this.preferredNick = opts.nick;
    this.nick = opts.nick;
    this.channel = opts.channel;
    this.password = opts.password;
    this.tls = !!opts.tls;
    this.owners = new Set((opts.owners ?? []).map((s) => s.toLowerCase()));
    this.onMessage = opts.onMessage;
  }

  /** Idempotent: at most one live connection for this client instance. */
  start() {
    if (this.stopped) {
      // Allow restart after stop() (e.g. tests); clear stopped first in stop? no — use reset
      this.stopped = false;
    }
    if (this.started) {
      // HMR re-import: keep existing socket; only refresh handlers if needed.
      console.error(
        `[irc] start() ignored — already running as ${this.nick} → ${this.host}:${this.port}`,
      );
      return;
    }
    this.started = true;
    this.connect();
    this.startWatchdog();
  }

  private touchRx() {
    this.lastRxAt = Date.now();
  }

  private startWatchdog() {
    if (this.watchdogTimer !== undefined) return;
    this.watchdogTimer = setInterval(
      () => this.watchdogTick(),
      WATCHDOG_INTERVAL_MS,
    );
    // Don't keep the process alive solely for the watchdog.
    this.watchdogTimer.unref?.();
  }

  private stopWatchdog() {
    if (this.watchdogTimer === undefined) return;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
  }

  private watchdogTick() {
    if (this.stopped || this.connecting) return;
    const sock = this.tlsSock ?? this.socket;
    if (!sock || sock.destroyed) return;
    // Only enforce liveness after we've fully registered/joined once on this
    // connection (or at least sent NICK/USER). lastRxAt is set on first ingest.
    if (!this.lastRxAt) return;

    const idle = Date.now() - this.lastRxAt;

    if (idle >= DEAD_AFTER_MS) {
      console.error(
        `[irc] no traffic for ${Math.round(idle / 1000)}s (dead after ${DEAD_AFTER_MS / 1000}s); forcing reconnect`,
      );
      this.forceReconnect("idle timeout");
      return;
    }

    // Proactively PING the server so a half-open socket fails fast (or we get
    // a PONG that refreshes lastRxAt). At most once per CLIENT_PING_AFTER_MS.
    if (
      idle >= CLIENT_PING_AFTER_MS &&
      Date.now() - this.lastPingAt >= CLIENT_PING_AFTER_MS
    ) {
      this.lastPingAt = Date.now();
      console.error(
        `[irc] idle ${Math.round(idle / 1000)}s; sending client PING`,
      );
      this.raw(`PING :eve-keepalive`);
    }
  }

  /**
   * Drop current sockets without treating their close as "unexpected disconnect".
   * Generation bump makes any in-flight close handlers no-ops.
   */
  private detachSockets(reason: string) {
    this.generation += 1;
    const gen = this.generation;
    console.error(`[irc] detach sockets gen=${gen} (${reason})`);

    const tlsSock = this.tlsSock;
    const sock = this.socket;
    this.tlsSock = null;
    this.socket = null;
    this.joined = false;
    this.joinedAt = 0;
    this.buf = "";
    this.lastRxAt = 0;
    this.lastPingAt = 0;

    // Remove listeners first so destroy → close cannot schedule reconnect.
    for (const s of [tlsSock, sock]) {
      if (!s) continue;
      try {
        s.removeAllListeners();
        s.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  /** Tear down the current socket immediately and schedule a fresh connect. */
  private forceReconnect(reason: string) {
    if (this.stopped) return;
    console.error(`[irc] force reconnect (${reason})`);
    this.clearReconnectTimer();
    this.connecting = false;
    this.detachSockets(reason);
    this.scheduleReconnect(2_000);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer === undefined) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private connect() {
    if (this.stopped) return;
    if (this.connecting) {
      console.error(`[irc] connect() already in flight; skipping`);
      return;
    }
    // If we already have a live socket, do not open another.
    const live = this.tlsSock ?? this.socket;
    if (live && !live.destroyed) {
      console.error(`[irc] connect() skipped — socket already live`);
      return;
    }

    this.connecting = true;
    this.clearReconnectTimer();
    // Bump generation and kill any stale fds before opening a new one.
    this.detachSockets("connect");

    const gen = this.generation;
    this.nick = this.preferredNick;

    console.error(
      `[irc] connect gen=${gen} → ${this.host}:${this.port} (tls=${this.tls}) as ${this.nick}`,
    );

    let sock: Socket;
    try {
      sock = net.connect(this.port, this.host);
    } catch (e) {
      this.connecting = false;
      console.error(
        "[irc] net.connect threw:",
        e instanceof Error ? e.message : e,
      );
      this.scheduleReconnect(5_000);
      return;
    }

    this.socket = sock;
    sock.setKeepAlive(true, TCP_KEEPALIVE_MS);
    sock.setNoDelay(true);
    sock.setEncoding("utf8");

    const onUnexpectedClose = (label: string) => {
      // Only the current generation may reconnect.
      if (gen !== this.generation) {
        console.error(
          `[irc] ignore ${label} close from stale gen=${gen} (current=${this.generation})`,
        );
        return;
      }
      if (this.stopped) return;
      console.error(`[irc] ${label} closed (gen=${gen}); will reconnect`);
      this.connecting = false;
      this.tlsSock = null;
      this.socket = null;
      this.joined = false;
      this.scheduleReconnect(5_000);
    };

    sock.on("connect", () => {
      if (gen !== this.generation) {
        try {
          sock.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      if (this.tls) {
        const tlsSock = tls.connect(
          { socket: sock, servername: this.host },
          () => {
            if (gen !== this.generation) {
              try {
                tlsSock.destroy();
              } catch {
                /* ignore */
              }
              return;
            }
            this.tlsSock = tlsSock;
            this.connecting = false;
            this.register();
          },
        );
        tlsSock.setEncoding("utf8");
        tlsSock.on("data", (d: string) => {
          if (gen !== this.generation) return;
          this.ingest(d);
        });
        tlsSock.on("error", (e) => {
          if (gen !== this.generation) return;
          this.connecting = false;
          this.handleErr(e);
        });
        // Prefer TLS close for reconnect; plain sock close under TLS is normal
        // once TLS owns the stream — do not double-reconnect.
        tlsSock.on("close", () => onUnexpectedClose("tls"));
        sock.on("error", (e) => {
          if (gen !== this.generation) return;
          this.handleErr(e);
        });
        // Under TLS, raw socket close alone is not a reconnect trigger if we
        // already have tlsSock; only reconnect if TLS never attached.
        sock.on("close", () => {
          if (gen !== this.generation) return;
          if (this.tlsSock) return; // TLS layer owns lifetime
          this.connecting = false;
          onUnexpectedClose("tcp(pre-tls)");
        });
      } else {
        this.connecting = false;
        this.register();
      }
    });

    if (!this.tls) {
      sock.on("data", (d: string) => {
        if (gen !== this.generation) return;
        this.ingest(d);
      });
      sock.on("close", () => onUnexpectedClose("tcp"));
    }

    sock.on("error", (e) => {
      if (gen !== this.generation) return;
      this.connecting = false;
      this.handleErr(e);
    });
  }

  private register() {
    if (this.password) {
      this.raw("CAP REQ :sasl");
    }
    this.raw(`NICK ${this.nick}`);
    this.raw(`USER ${this.nick} 0 * :eve agent`);
  }

  private ingest(data: string) {
    this.touchRx();
    this.buf += data;
    let nl: number;
    while ((nl = this.buf.indexOf("\r\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 2);
      if (line) this.handle(line);
    }
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      if (line) this.handle(line);
    }
  }

  private handle(line: string) {
    if (line.includes("PRIVMSG"))
      console.error(`[irc] << ${line.slice(0, 180)}`);
    const m = parseIrcLine(line);
    const cmd = m.command.toUpperCase();
    if (cmd === "PING") {
      this.raw(`PONG :${m.params[0] ?? ""}`);
      return;
    }
    if (cmd === "PONG") {
      // Server answered our client PING (or freeq echoed one). lastRxAt already
      // updated in ingest; nothing else to do.
      return;
    }
    if (
      cmd === "CAP" &&
      m.params[1] === "ACK" &&
      /sasl/.test(m.params[2] ?? "")
    ) {
      this.raw("AUTHENTICATE PLAIN");
      return;
    }
    if (cmd === "AUTHENTICATE" && m.params[0] === "+") {
      const blob = Buffer.from(
        `\0${this.nick}\0${this.password}`,
        "utf8",
      ).toString("base64");
      this.raw(`AUTHENTICATE ${blob}`);
      this.raw("CAP END");
      return;
    }
    if (cmd === "433") {
      // Nickname already in use — our nick failed but the socket is still alive.
      // Don't reconnect: just pick a fresh nick with a random suffix and send
      // NICK on this same connection. No new socket, no duplicate connections.
      // Base the suffix on preferredNick so reconnects can reclaim the real nick.
      const suffix = Math.random().toString(36).slice(2, 6);
      const newNick = `${this.preferredNick}-${suffix}`;
      console.error(`[irc] nick in use; retrying as ${newNick}`);
      this.nick = newNick;
      this.raw(`NICK ${newNick}`);
      return;
    }
    if (cmd === "001") {
      this.raw(`JOIN ${this.channel}`);
      return;
    }
    if (cmd === "JOIN" && nickFromPrefix(m.prefix) === this.nick) {
      this.joined = true;
      this.joinedAt = Date.now();
      console.error(
        `[irc] joined ${this.channel} on ${this.host} as ${this.nick}`,
      );
      return;
    }
    if (cmd === "PRIVMSG") {
      const from = nickFromPrefix(m.prefix);
      const target = m.params[0] ?? "";
      const text = m.params[1] ?? "";
      this.handlePrivmsg(from, target, text);
      return;
    }
  }

  private handlePrivmsg(from: string, target: string, text: string) {
    if (from === this.nick) return;
    if (this.isDuplicatePrivmsg(from, target, text)) return;
    const isChannel = target.startsWith("#") || target.startsWith("&");
    // freeq sends channel history on JOIN; drop channel messages for a short
    // quiet window after our own JOIN echo so backlog doesn't trigger replies.
    if (isChannel && this.joinedAt && Date.now() - this.joinedAt < 5_000)
      return;
    let replyTarget = target;
    let body = text;
    if (isChannel) {
      const mention = new RegExp(`^${this.nick}[,: ]+`, "i");
      if (!mention.test(text)) return;
      body = text.replace(mention, "").trim();
      replyTarget = target;
    } else {
      if (this.owners.size && !this.owners.has(from.toLowerCase())) {
        this.sendPrivmsg(from, "not authorized");
        return;
      }
      replyTarget = from;
    }
    if (!body) return;
    this.onMessage(from, replyTarget, body);
  }

  /**
   * Some servers / bridges may deliver the same PRIVMSG more than once in quick
   * succession (echo, retry, or federation fan-out). Deduplicate by
   * (from, target, text) within a short window so the agent doesn't answer twice.
   */
  private isDuplicatePrivmsg(from: string, target: string, text: string): boolean {
    const now = Date.now();
    const windowMs = 5_000;
    // Drop entries older than the window.
    const cutoff = now - windowMs;
    let i = 0;
    while (i < this.recentMsgs.length && this.recentMsgs[i].at < cutoff) {
      i++;
    }
    if (i > 0) this.recentMsgs.splice(0, i);

    const key = `${from}\0${target}\0${text}`;
    if (this.recentMsgs.some((m) => m.key === key)) {
      console.error(`[irc] duplicate PRIVMSG dropped: ${from} → ${target}`);
      return true;
    }
    this.recentMsgs.push({ key, at: now });
    return false;
  }

  sendPrivmsg(target: string, text: string) {
    console.error(
      `[irc] sendPrivmsg -> ${target}: ${String(text).slice(0, 60)}`,
    );
    // IRC messages are CRLF-delimited; the server treats the first \r\n as
    // the end of the message. Multi-line content (e.g. ASCII art) must be
    // split into separate PRIVMSGs, one per line. Otherwise only the first
    // line reaches the channel and the rest is silently dropped as garbage.
    const maxBody = 512 - `PRIVMSG ${target} :\r\n`.length;
    const lines = String(text).split("\n");
    for (const line of lines) {
      if (!line && lines.length > 1) continue;
      const chunks = line.match(new RegExp(`[\\s\\S]{1,${maxBody}}`, "g")) ?? [
        line,
      ];
      for (const c of chunks) this.raw(`PRIVMSG ${target} :${c}`);
    }
  }

  private raw(line: string) {
    const s = this.tlsSock ?? this.socket;
    if (!s || s.destroyed) return;
    s.write(line + "\r\n");
  }

  private handleErr(e: unknown) {
    console.error("[irc] socket error:", e instanceof Error ? e.message : e);
  }

  private scheduleReconnect(delayMs = 5_000) {
    if (this.stopped) return;
    if (this.reconnectTimer !== undefined) {
      console.error(`[irc] reconnect already scheduled; not stacking`);
      return;
    }
    if (this.connecting) {
      console.error(`[irc] reconnect deferred — connect already in flight`);
      return;
    }
    console.error(`[irc] reconnecting in ${delayMs / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    this.started = false;
    this.connecting = false;
    this.clearReconnectTimer();
    this.stopWatchdog();
    try {
      this.raw("QUIT :eve agent shutting down");
    } catch {
      /* ignore */
    }
    this.detachSockets("stop");
  }
}

// ---------------------------------------------------------------------------
// Channel — process-wide singleton client
// ---------------------------------------------------------------------------

const IRC_HOST = process.env.IRC_HOST ?? "irc.libera.chat";
const IRC_PORT = Number(process.env.IRC_PORT ?? 6697);
const IRC_NICK = process.env.IRC_NICK ?? "eve-agent";
const IRC_CHANNEL = process.env.IRC_CHANNEL ?? "#eve-agent";
const IRC_PASSWORD = process.env.IRC_PASSWORD || undefined;
const IRC_TLS = process.env.IRC_TLS !== "0" && process.env.IRC_TLS !== "false";
const IRC_OWNERS = (process.env.IRC_OWNERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const INBOUND_URL = `http://127.0.0.1:${process.env.PORT ?? 8000}/irc/inbound`;

function makeOnMessage(): (from: string, target: string, text: string) => void {
  return (from, target, text) => {
    fetch(INBOUND_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, target, text }),
    }).catch((e) =>
      console.error(
        "[irc] inbound post failed:",
        e instanceof Error ? e.message : e,
      ),
    );
  };
}

function getOrCreateIrcClient(): IrcClient {
  const bag = globalBag();
  if (bag.client) {
    // HMR may re-bind inbound handler; keep the same socket.
    bag.client.onMessage = makeOnMessage();
    return bag.client;
  }
  const client = new IrcClient({
    host: IRC_HOST,
    port: IRC_PORT,
    nick: IRC_NICK,
    channel: IRC_CHANNEL,
    password: IRC_PASSWORD,
    tls: IRC_TLS,
    owners: IRC_OWNERS,
    onMessage: makeOnMessage(),
  });
  bag.client = client;
  return client;
}

const irc = getOrCreateIrcClient();
irc.start();

const bag = globalBag();
if (!bag.signalHandlersBound) {
  bag.signalHandlersBound = true;
  process.on("SIGTERM", () => {
    globalBag().client?.stop();
  });
  process.on("SIGINT", () => {
    globalBag().client?.stop();
  });
}

function isHookConflict(msg: string): boolean {
  return /already in use|HookConflict/i.test(msg);
}

/** Target shape for schedule / cross-channel `receive(irc, { target })`. */
export type IrcReceiveTarget = {
  /** IRC destination (#channel or nick). Defaults to IRC_CHANNEL. */
  channel?: string;
};

export default defineChannel<IrcState, IrcCtx, IrcReceiveTarget>({
  state: { from: null, target: null },

  context(state, _session) {
    return { state, irc };
  },

  metadata(state) {
    return { from: state.from, target: state.target };
  },

  // Schedules and other channels hand work here; agent reply is PRIVMSG'd to target.
  async receive(input, { send }) {
    const channel =
      (typeof input.target?.channel === "string" &&
        input.target.channel.trim()) ||
      IRC_CHANNEL;
    const token = `schedule:${channel}`;
    return send(input.message, {
      auth: input.auth,
      continuationToken: token,
      state: { from: "schedule", target: channel },
      title: `irc schedule → ${channel}`,
    });
  },

  routes: [
    POST("/irc/inbound", async (req, { send }) => {
      const body = (await req.json()) as {
        from: string;
        target: string;
        text: string;
      };
      try {
        await send(body.text, {
          auth: {
            authenticator: "irc",
            principalType: "user",
            principalId: body.from,
            attributes: { target: body.target },
          },
          continuationToken: body.from,
          state: { from: body.from, target: body.target },
          title: `irc: ${body.from}`,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isHookConflict(msg)) {
          irc.sendPrivmsg(
            body.target,
            `${body.from}: still thinking about your last message — try again in a moment.`,
          );
        } else {
          irc.sendPrivmsg(body.target, `[error] ${msg.slice(0, 200)}`);
        }
      }
      return new Response("ok");
    }),
  ],

  events: {
    "message.completed"(data, channel) {
      const text = data.message;
      if (!text) return;
      const target = channel.state.target ?? channel.state.from;
      if (!target) return;
      channel.irc.sendPrivmsg(target, text);
    },
    "turn.failed"(data, channel) {
      const target = channel.state.target ?? channel.state.from;
      if (!target) return;
      const msg = data.details?.message ?? data.message ?? "turn failed";
      // HookConflictError = user sent a 2nd message while a turn was still
      // running. Give a friendly heads-up instead of a raw error.
      if (isHookConflict(String(msg))) {
        channel.irc.sendPrivmsg(
          target,
          `${channel.state.from ?? "you"}: still thinking about your last message — try again in a moment.`,
        );
        return;
      }
      channel.irc.sendPrivmsg(target, `[error] ${String(msg).slice(0, 300)}`);
    },
    "session.failed"(data, channel) {
      const target = channel.state.target ?? channel.state.from;
      if (!target) return;
      const msg = data.details?.message ?? data.message ?? "session failed";
      if (isHookConflict(String(msg))) {
        channel.irc.sendPrivmsg(
          target,
          `${channel.state.from ?? "you"}: still thinking about your last message — try again in a moment.`,
        );
        return;
      }
      channel.irc.sendPrivmsg(target, `[error] ${String(msg).slice(0, 300)}`);
    },
  },
});
