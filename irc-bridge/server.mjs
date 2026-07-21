#!/usr/bin/env node
/**
 * Standalone IRC client for freeq.
 *
 *   freeq IRC  ←TLS→  this process  ─POST→  eve /irc/inbound
 *                              ↑
 *                         SSE /irc/out  (replies to send as PRIVMSG)
 *
 * Eve never opens an IRC socket. HMR/restart of eve does not drop IRC.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const IRC_HOST = process.env.IRC_HOST ?? "irc.freeq.at";
const IRC_PORT = Number(process.env.IRC_PORT ?? 6697);
const IRC_TLS = process.env.IRC_TLS !== "0" && process.env.IRC_TLS !== "false";
const IRC_NICK = process.env.IRC_NICK ?? "eve";
const IRC_CHANNEL = process.env.IRC_CHANNEL ?? "#test";
const IRC_PASSWORD = process.env.IRC_PASSWORD || undefined;
const IRC_OWNERS = new Set(
  (process.env.IRC_OWNERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

const EVE_URL = (process.env.EVE_URL ?? "http://127.0.0.1:8000").replace(
  /\/$/,
  "",
);
const INBOUND_PATH = process.env.IRC_INBOUND_PATH ?? "/irc/inbound";
const OUT_SSE_PATH = process.env.IRC_OUT_SSE_PATH ?? "/irc/out";

const BACKLOG_MIN_MS = envMs("IRC_BACKLOG_MIN_MS", 3_000);
const BACKLOG_GAP_MS = envMs("IRC_BACKLOG_GAP_MS", 2_000);
const BACKLOG_MAX_MS = envMs("IRC_BACKLOG_MAX_MS", 30_000);
const WATCHDOG_MS = envMs("IRC_WATCHDOG_MS", 30_000);
const PING_AFTER_MS = envMs("IRC_PING_AFTER_MS", 60_000);
const DEAD_AFTER_MS = envMs("IRC_DEAD_AFTER_MS", 120_000);
const TCP_KEEPALIVE_MS = envMs("IRC_TCP_KEEPALIVE_MS", 30_000);

/** How many recent PRIVMSGs (per target) to keep for channel context. */
const CONTEXT_LINES = envInt("IRC_CONTEXT_LINES", 40);
/** Cap formatted context size so prompts stay bounded. */
const CONTEXT_MAX_CHARS = envInt("IRC_CONTEXT_MAX_CHARS", 6_000);

function envMs(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// ---------------------------------------------------------------------------
// Per-target ring buffer (channel scrollback for eve context)
// ---------------------------------------------------------------------------

/** @type {Map<string, Array<{ from: string, text: string, at: number }>>} */
const contextBuffers = new Map();

function pushContext(target, from, text) {
  if (!target || !from) return;
  const key = target.toLowerCase();
  let buf = contextBuffers.get(key);
  if (!buf) {
    buf = [];
    contextBuffers.set(key, buf);
  }
  const line = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return;
  buf.push({ from, text: line.slice(0, 400), at: Date.now() });
  while (buf.length > CONTEXT_LINES) buf.shift();
}

/**
 * Format recent lines for eve's `context` field (user-role messages before
 * the mention). Omits the triggering mention line when `excludeText` matches
 * the last entry (mention is the delivery message, not context).
 */
function formatContext(target, { excludeFrom, excludeText } = {}) {
  const buf = contextBuffers.get(String(target).toLowerCase()) ?? [];
  if (!buf.length) return [];
  let lines = buf;
  if (excludeFrom && excludeText) {
    const last = buf[buf.length - 1];
    const body = String(excludeText).replace(/\s+/g, " ").trim();
    if (
      last &&
      last.from === excludeFrom &&
      (last.text === body ||
        last.text.endsWith(body) ||
        body.endsWith(last.text))
    ) {
      lines = buf.slice(0, -1);
    }
  }
  if (!lines.length) return [];
  const rendered = lines.map((e) => `<${e.from}> ${e.text}`);
  let block = `Recent IRC in ${target} (oldest → newest, ${lines.length} lines):\n${rendered.join("\n")}`;
  if (block.length > CONTEXT_MAX_CHARS) {
    block = `…(truncated)\n` + block.slice(-(CONTEXT_MAX_CHARS - 14));
  }
  return [block];
}

function log(...args) {
  console.error("[irc-bridge]", ...args);
}

// ---------------------------------------------------------------------------
// Freeq session (ATPROTO-CHALLENGE pds-oauth)
// ---------------------------------------------------------------------------

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function b64urlJson(obj) {
  return b64url(Buffer.from(JSON.stringify(obj)));
}
function sha256b64url(data) {
  return b64url(crypto.createHash("sha256").update(data).digest());
}

function p256PrivateKeyFromRaw(raw32) {
  const derEncodeLen = (n) => {
    if (n < 0x80) return Buffer.from([n]);
    if (n < 0x100) return Buffer.from([0x81, n]);
    return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
  };
  const seq = (...parts) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([
      Buffer.from([0x30]),
      derEncodeLen(body.length),
      body,
    ]);
  };
  const octetString = (buf) =>
    Buffer.concat([Buffer.from([0x04]), derEncodeLen(buf.length), buf]);
  const integer1 = () => Buffer.from([0x02, 0x01, 0x01]);
  const ecAlgId = Buffer.from(
    "301306072a8648ce3d020106082a8648ce3d030107",
    "hex",
  );
  const ecPrivateKey = seq(integer1(), octetString(raw32));
  const pkcs8 = seq(
    Buffer.from([0x02, 0x01, 0x00]),
    ecAlgId,
    octetString(ecPrivateKey),
  );
  return crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
}

function loadFreeqSession() {
  const candidates = [];
  if (process.env.IRC_FREEQ_SESSION)
    candidates.push(process.env.IRC_FREEQ_SESSION);
  const home = process.env.HOME ?? os.homedir();
  candidates.push(
    path.join(home, ".config/freeq-tui/eve.rookery.boxd.sh.session.json"),
    path.join(home, ".config/freeq/eve.rookery.boxd.sh.session.json"),
  );
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      if (
        typeof raw.did === "string" &&
        typeof raw.access_token === "string" &&
        typeof raw.pds_url === "string" &&
        typeof raw.dpop_key === "string"
      ) {
        log(`loaded freeq session from ${p} (${raw.did})`);
        return raw;
      }
    } catch (e) {
      log(
        `failed to load freeq session ${p}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return null;
}

function makeOauthDpop(session, method, htu, accessToken, nonce) {
  const dBytes = Buffer.from(session.dpop_key, "base64url");
  const priv = p256PrivateKeyFromRaw(dBytes);
  const jwk = priv.export({ format: "jwk" });
  const pubJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  const payload = {
    jti: crypto.randomUUID(),
    htm: method,
    htu,
    iat: Math.floor(Date.now() / 1000),
    ath: sha256b64url(accessToken),
  };
  if (nonce) payload.nonce = nonce;
  const input = `${b64urlJson({ typ: "dpop+jwt", alg: "ES256", jwk: pubJwk })}.${b64urlJson(payload)}`;
  const sig = crypto.sign("sha256", Buffer.from(input, "ascii"), {
    key: priv,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${b64url(sig)}`;
}

// ---------------------------------------------------------------------------
// IRC line parse
// ---------------------------------------------------------------------------

function parseIrcLine(line) {
  // IRCv3 message-tags: @tag=val;tag=val :prefix CMD params :trailing
  // Must strip tags first or the first " :" is after tags and parsing breaks.
  let rest = line;
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    if (sp === -1) return { command: "", params: [], prefix: undefined };
    rest = rest.slice(sp + 1);
  }
  let prefix;
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  let trailing;
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

function nickFromPrefix(prefix) {
  if (!prefix) return "";
  return prefix.split("!")[0];
}

// ---------------------------------------------------------------------------
// IRC client
// ---------------------------------------------------------------------------

class IrcClient {
  constructor(opts) {
    this.host = opts.host;
    this.port = opts.port;
    this.preferredNick = opts.nick;
    this.nick = opts.nick;
    this.channel = opts.channel;
    this.password = opts.password;
    this.tls = !!opts.tls;
    this.owners = opts.owners ?? new Set();
    this.freeqSession = opts.freeqSession ?? null;
    this.onMessage = opts.onMessage;
    this.socket = null;
    this.tlsSock = null;
    this.buf = "";
    this.joined = false;
    this.joinedAt = 0;
    this.backlogActive = false;
    this.lastChannelMsgAt = 0;
    this.backlogDropped = 0;
    this.stopped = false;
    this.connecting = false;
    this.generation = 0;
    this.lastRxAt = 0;
    this.lastPingAt = 0;
    this.authDid = null;
    this.reconnectTimer = undefined;
    this.watchdogTimer = undefined;
  }

  start() {
    this.stopped = false;
    this.connect();
    this.startWatchdog();
  }

  stop() {
    this.stopped = true;
    this.connecting = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    try {
      this.raw("QUIT :irc-bridge shutting down");
    } catch {
      /* ignore */
    }
    this.detachSockets("stop");
  }

  sendPrivmsg(target, text) {
    const maxBody = 512 - `PRIVMSG ${target} :\r\n`.length;
    const lines = String(text).split("\n");
    for (const line of lines) {
      if (!line && lines.length > 1) continue;
      const chunks = line.match(new RegExp(`[\\s\\S]{1,${maxBody}}`, "g")) ?? [
        line,
      ];
      for (const c of chunks) this.raw(`PRIVMSG ${target} :${c}`);
    }
    // Keep our own replies in the ring buffer so the next mention sees them.
    pushContext(target, this.nick, text);
    log(`→ PRIVMSG ${target}: ${String(text).slice(0, 80)}`);
  }

  startWatchdog() {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => this.watchdogTick(), WATCHDOG_MS);
    this.watchdogTimer.unref?.();
  }

  watchdogTick() {
    if (this.stopped || this.connecting || !this.lastRxAt) return;
    const sock = this.tlsSock ?? this.socket;
    if (!sock || sock.destroyed) return;
    const idle = Date.now() - this.lastRxAt;
    if (idle >= DEAD_AFTER_MS) {
      log(`no traffic ${Math.round(idle / 1000)}s; reconnect`);
      this.forceReconnect("idle");
      return;
    }
    if (
      idle >= PING_AFTER_MS &&
      Date.now() - this.lastPingAt >= PING_AFTER_MS
    ) {
      this.lastPingAt = Date.now();
      this.raw("PING :irc-bridge");
    }
  }

  detachSockets(reason) {
    this.generation += 1;
    log(`detach sockets gen=${this.generation} (${reason})`);
    const a = this.tlsSock;
    const b = this.socket;
    this.tlsSock = null;
    this.socket = null;
    this.joined = false;
    this.joinedAt = 0;
    this.backlogActive = false;
    this.buf = "";
    this.lastRxAt = 0;
    for (const s of [a, b]) {
      if (!s) continue;
      try {
        s.removeAllListeners();
        s.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  forceReconnect(reason) {
    if (this.stopped) return;
    this.connecting = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.detachSockets(reason);
    this.scheduleReconnect(2_000);
  }

  scheduleReconnect(delayMs = 5_000) {
    if (this.stopped || this.reconnectTimer) return;
    log(`reconnect in ${delayMs / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  connect() {
    if (this.stopped || this.connecting) return;
    const live = this.tlsSock ?? this.socket;
    if (live && !live.destroyed) return;

    this.connecting = true;
    this.detachSockets("connect");
    const gen = this.generation;
    this.nick = this.preferredNick;
    log(
      `connect gen=${gen} → ${this.host}:${this.port} tls=${this.tls} as ${this.nick}`,
    );

    let sock;
    try {
      sock = net.connect(this.port, this.host);
    } catch (e) {
      this.connecting = false;
      log("net.connect threw", e instanceof Error ? e.message : e);
      this.scheduleReconnect(5_000);
      return;
    }
    this.socket = sock;
    sock.setKeepAlive(true, TCP_KEEPALIVE_MS);
    sock.setNoDelay(true);
    sock.setEncoding("utf8");

    const onClose = (label) => {
      if (gen !== this.generation || this.stopped) return;
      log(`${label} closed; reconnect`);
      this.connecting = false;
      this.tlsSock = null;
      this.socket = null;
      this.joined = false;
      this.scheduleReconnect(5_000);
    };

    sock.on("connect", () => {
      if (gen !== this.generation) {
        sock.destroy();
        return;
      }
      if (this.tls) {
        const tlsSock = tls.connect(
          { socket: sock, servername: this.host },
          () => {
            if (gen !== this.generation) {
              tlsSock.destroy();
              return;
            }
            this.tlsSock = tlsSock;
            this.connecting = false;
            this.register();
          },
        );
        tlsSock.setEncoding("utf8");
        tlsSock.on("data", (d) => {
          if (gen === this.generation) this.ingest(d);
        });
        tlsSock.on("error", (e) => {
          if (gen === this.generation) log("tls error", e.message);
        });
        tlsSock.on("close", () => onClose("tls"));
        sock.on("close", () => {
          if (gen !== this.generation || this.tlsSock) return;
          this.connecting = false;
          onClose("tcp(pre-tls)");
        });
      } else {
        this.connecting = false;
        this.register();
      }
    });

    if (!this.tls) {
      sock.on("data", (d) => {
        if (gen === this.generation) this.ingest(d);
      });
      sock.on("close", () => onClose("tcp"));
    }
    sock.on("error", (e) => {
      if (gen === this.generation) {
        this.connecting = false;
        log("socket error", e.message);
      }
    });
  }

  register() {
    this.raw("CAP LS 302");
    this.raw(`NICK ${this.nick}`);
    this.raw(`USER ${this.nick} 0 * :eve irc-bridge`);
  }

  raw(line) {
    const s = this.tlsSock ?? this.socket;
    if (!s || s.destroyed) return;
    s.write(line + "\r\n");
  }

  ingest(data) {
    this.lastRxAt = Date.now();
    this.buf += data;
    let nl;
    while ((nl = this.buf.indexOf("\r\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 2);
      if (line) this.handle(line);
    }
  }

  handle(line) {
    if (line.includes("PRIVMSG")) log("<<", line.slice(0, 160));
    const m = parseIrcLine(line);
    const cmd = m.command.toUpperCase();

    if (cmd === "PING") {
      this.raw(`PONG :${m.params[0] ?? ""}`);
      return;
    }
    if (cmd === "PONG") return;

    if (cmd === "CAP") {
      this.handleCap(m);
      return;
    }
    if (cmd === "AUTHENTICATE") {
      this.handleAuthenticate(m);
      return;
    }
    if (cmd === "903") {
      log(`SASL success${this.authDid ? ` as ${this.authDid}` : ""}`);
      this.raw("CAP END");
      return;
    }
    if (cmd === "904" || cmd === "905") {
      log(`SASL failed (${cmd}): ${m.params[m.params.length - 1] ?? ""}`);
      this.raw("CAP END");
      return;
    }
    if (cmd === "433") {
      const suffix = Math.random().toString(36).slice(2, 6);
      this.nick = `${this.preferredNick}-${suffix}`;
      log(`nick in use; trying ${this.nick}`);
      this.raw(`NICK ${this.nick}`);
      return;
    }
    if (cmd === "001") {
      this.raw(`JOIN ${this.channel}`);
      return;
    }
    if (cmd === "JOIN" && nickFromPrefix(m.prefix) === this.nick) {
      const now = Date.now();
      this.joined = true;
      this.joinedAt = now;
      this.backlogActive = true;
      this.lastChannelMsgAt = now;
      this.backlogDropped = 0;
      log(
        `joined ${this.channel} as ${this.nick} (backlog min=${BACKLOG_MIN_MS} gap=${BACKLOG_GAP_MS} max=${BACKLOG_MAX_MS})`,
      );
      return;
    }
    if (cmd === "PRIVMSG") {
      this.handlePrivmsg(
        nickFromPrefix(m.prefix),
        m.params[0] ?? "",
        m.params[1] ?? "",
      );
    }
  }

  handleCap(m) {
    const sub = (m.params[1] ?? "").toUpperCase();
    const rest = m.params.slice(2).join(" ");
    if (sub === "LS") {
      const available = rest.toLowerCase();
      const wanted = [];
      if (available.includes("sasl") && (this.freeqSession || this.password)) {
        wanted.push("sasl");
      }
      for (const c of ["account-tag", "extended-join", "message-tags"]) {
        if (available.includes(c)) wanted.push(c);
      }
      if (wanted.length) this.raw(`CAP REQ :${wanted.join(" ")}`);
      else this.raw("CAP END");
      return;
    }
    if (sub === "ACK") {
      if (/sasl/i.test(rest)) {
        if (this.freeqSession) this.raw("AUTHENTICATE ATPROTO-CHALLENGE");
        else if (this.password) this.raw("AUTHENTICATE PLAIN");
        else this.raw("CAP END");
      } else this.raw("CAP END");
      return;
    }
    if (sub === "NAK") this.raw("CAP END");
  }

  handleAuthenticate(m) {
    const param = m.params[0] ?? "";
    if (param === "+" && this.password && !this.freeqSession) {
      const blob = Buffer.from(
        `\0${this.nick}\0${this.password}`,
        "utf8",
      ).toString("base64");
      this.raw(`AUTHENTICATE ${blob}`);
      this.raw("CAP END");
      return;
    }
    if (param === "+" || !param || !this.freeqSession) return;

    let challengeNonce;
    try {
      const padded = param.replace(/-/g, "+").replace(/_/g, "/");
      const bin = Buffer.from(
        padded + "=".repeat((4 - (padded.length % 4)) % 4),
        "base64",
      );
      challengeNonce = JSON.parse(bin.toString("utf8")).nonce;
    } catch {
      /* ignore */
    }

    const session = this.freeqSession;
    const pds = session.pds_url.replace(/\/$/, "");
    const getSessionUrl = `${pds}/xrpc/com.atproto.server.getSession`;
    const dpopProof = makeOauthDpop(
      session,
      "GET",
      getSessionUrl,
      session.access_token,
      session.dpop_nonce,
    );
    const response = JSON.stringify({
      did: session.did,
      method: "pds-oauth",
      signature: session.access_token,
      pds_url: pds,
      dpop_proof: dpopProof,
      challenge_nonce: challengeNonce,
    });
    const encoded = Buffer.from(response, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    this.authDid = session.did;
    log(`AUTHENTICATE pds-oauth ${encoded.length} chars`);
    this.raw(`AUTHENTICATE ${encoded}`);
  }

  shouldDropBacklog() {
    if (!this.backlogActive || !this.joinedAt) return false;
    const now = Date.now();
    const sinceJoin = now - this.joinedAt;
    if (sinceJoin >= BACKLOG_MAX_MS) {
      this.endBacklog("max");
      return false;
    }
    if (sinceJoin < BACKLOG_MIN_MS) return true;
    if (now - this.lastChannelMsgAt < BACKLOG_GAP_MS) return true;
    this.endBacklog("gap");
    return false;
  }

  endBacklog(reason) {
    if (!this.backlogActive) return;
    this.backlogActive = false;
    log(
      `backlog ended (${reason}); dropped ${this.backlogDropped} after ${Math.round((Date.now() - this.joinedAt) / 1000)}s`,
    );
  }

  handlePrivmsg(from, target, text) {
    if (from === this.nick) return;
    const isChannel = target.startsWith("#") || target.startsWith("&");
    if (isChannel) {
      if (this.shouldDropBacklog()) {
        this.lastChannelMsgAt = Date.now();
        this.backlogDropped += 1;
        return;
      }
      // Record every live channel line (including the mention) for scrollback.
      pushContext(target, from, text);
      const aliases = [
        ...new Set([this.nick, this.preferredNick, "eve", "eve-agent"]),
      ];
      const alt = aliases
        .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|");
      const mention = new RegExp(`^(?:${alt})[,: ]+`, "i");
      if (!mention.test(text)) return;
      const body = text.replace(mention, "").trim();
      if (!body) return;
      const context = formatContext(target, {
        excludeFrom: from,
        excludeText: text,
      });
      log(
        `mention from ${from} in ${target}: ${body.slice(0, 80)} (context ${context.length ? context[0].length : 0} chars)`,
      );
      this.onMessage(from, target, body, context);
      return;
    }
    if (this.owners.size && !this.owners.has(from.toLowerCase())) {
      this.sendPrivmsg(from, "not authorized");
      return;
    }
    if (!text.trim()) return;
    // DMs: small private buffer so multi-line questions still have prior turns.
    pushContext(from, from, text);
    const context = formatContext(from, {
      excludeFrom: from,
      excludeText: text,
    });
    this.onMessage(from, from, text.trim(), context);
  }
}

// ---------------------------------------------------------------------------
// Eve HTTP: inbound POST + outbound SSE
// ---------------------------------------------------------------------------

async function postInbound(from, target, text, context) {
  const url = `${EVE_URL}${INBOUND_PATH}`;
  const payload = { from, target, text };
  if (Array.isArray(context) && context.length > 0) {
    payload.context = context;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      log(`inbound POST ${res.status} ${res.statusText}`);
    }
  } catch (e) {
    log(`inbound POST failed: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Long-lived SSE to eve. Events:
 *   event: privmsg
 *   data: {"target":"#test","text":"..."}
 */
async function runSseLoop(irc) {
  const url = `${EVE_URL}${OUT_SSE_PATH}`;
  let backoff = 1_000;
  while (!irc.stopped) {
    try {
      log(`SSE connect ${url}`);
      const res = await fetch(url, {
        headers: { accept: "text/event-stream", "cache-control": "no-cache" },
        // long-lived stream — no AbortSignal timeout
      });
      if (!res.ok || !res.body) {
        log(`SSE HTTP ${res.status}`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      backoff = 1_000;
      log("SSE connected");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          handleSseBlock(block, irc);
        }
      }
      log("SSE stream ended");
    } catch (e) {
      if (irc.stopped) break;
      log(`SSE error: ${e instanceof Error ? e.message : e}`);
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }
}

function handleSseBlock(block, irc) {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return;
  if (event === "ping" || data === ":") return;
  try {
    const msg = JSON.parse(data);
    if (msg.type === "privmsg" || event === "privmsg") {
      const target = msg.target ?? IRC_CHANNEL;
      const text = msg.text ?? msg.message ?? "";
      if (text) irc.sendPrivmsg(target, text);
    }
  } catch (e) {
    log(`SSE bad JSON: ${data.slice(0, 120)}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Wait until eve HTTP is up
async function waitForEve(timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(EVE_URL, { signal: AbortSignal.timeout(3_000) });
      if (res.ok || res.status === 404 || res.status === 200) {
        log(`eve reachable at ${EVE_URL} (${res.status})`);
        return;
      }
    } catch {
      /* retry */
    }
    await sleep(1_000);
  }
  log(
    `warning: eve not reachable at ${EVE_URL} after ${timeoutMs}ms; continuing`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const freeqSession = loadFreeqSession();
if (freeqSession) {
  log(`freeq session → ${freeqSession.pds_url} as ${freeqSession.handle}`);
} else {
  log("no freeq session; guest/plain SASL only");
}

const irc = new IrcClient({
  host: IRC_HOST,
  port: IRC_PORT,
  nick: IRC_NICK,
  channel: IRC_CHANNEL,
  password: freeqSession ? undefined : IRC_PASSWORD,
  tls: IRC_TLS,
  owners: IRC_OWNERS,
  freeqSession,
  onMessage: (from, target, text, context) => {
    void postInbound(from, target, text, context);
  },
});

process.on("SIGTERM", () => {
  irc.stop();
  process.exit(0);
});
process.on("SIGINT", () => {
  irc.stop();
  process.exit(0);
});

await waitForEve();
irc.start();
// SSE loop in parallel (reconnects forever)
void runSseLoop(irc);

log(
  `running nick=${IRC_NICK} channel=${IRC_CHANNEL} eve=${EVE_URL} inbound=${INBOUND_PATH} out=${OUT_SSE_PATH} contextLines=${CONTEXT_LINES}`,
);
