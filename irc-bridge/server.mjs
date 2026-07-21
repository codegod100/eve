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
import * as http from "node:http";
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

/** Control HTTP for eve tools (play radio / ensure AV). */
const CONTROL_HOST = process.env.IRC_CONTROL_HOST ?? "127.0.0.1";
const CONTROL_PORT = Number(process.env.IRC_CONTROL_PORT ?? 8791);
/** eve-av-bridge base URL (media plane). */
const AV_BRIDGE_URL = (
  process.env.AV_BRIDGE_URL ?? "http://127.0.0.1:8790"
).replace(/\/$/, "");
/** freeq REST (session discovery). Default from IRC host. */
const FREEQ_API_BASE = (
  process.env.FREEQ_API_BASE ?? `https://${IRC_HOST}`
).replace(/\/$/, "");
/** MoQ SFU URL (https for QUIC). freeq default :8080/av/moq */
const SFU_URL_RESOLVED =
  process.env.SFU_URL ??
  (IRC_HOST.includes("freeq")
    ? "https://irc.freeq.at:8080/av/moq"
    : `https://${IRC_HOST}/av/moq`);

function envMs(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

/** IRCv3 tag-value escape (message-tags §). */
function escapeTagValue(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\:")
    .replace(/ /g, "\\s")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function unescapeTagValue(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      const n = s[++i];
      if (n === ":") out += ";";
      else if (n === "s") out += " ";
      else if (n === "\\") out += "\\";
      else if (n === "r") out += "\r";
      else if (n === "n") out += "\n";
      else out += n;
    } else out += c;
  }
  return out;
}

/** Parse `@k=v;k2=v2 ` tag prefix into a map. Keys keep their `+` if client-only. */
function parseIrcTags(line) {
  /** @type {Record<string, string>} */
  const tags = {};
  if (!line.startsWith("@")) return { tags, rest: line };
  const sp = line.indexOf(" ");
  if (sp === -1) return { tags, rest: "" };
  const tagPart = line.slice(1, sp);
  const rest = line.slice(sp + 1);
  for (const item of tagPart.split(";")) {
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq === -1) tags[item] = "";
    else tags[item.slice(0, eq)] = unescapeTagValue(item.slice(eq + 1));
  }
  return { tags, rest };
}

function parseIrcLine(line) {
  // IRCv3 message-tags: @tag=val;tag=val :prefix CMD params :trailing
  // Must strip tags first or the first " :" is after tags and parsing breaks.
  const { tags, rest: afterTags } = parseIrcTags(line);
  let rest = afterTags;
  if (!rest) return { command: "", params: [], prefix: undefined, tags };
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
  return { command, params, prefix, tags };
}

function nickFromPrefix(prefix) {
  if (!prefix) return "";
  return prefix.split("!")[0];
}

/** Eyes reaction used as "working on it" ACK (same idea as GitHub 👀). */
const WORKING_REACT =
  process.env.IRC_WORKING_REACT && process.env.IRC_WORKING_REACT.length > 0
    ? process.env.IRC_WORKING_REACT
    : "👀";

// ---------------------------------------------------------------------------
// IRC client
// ---------------------------------------------------------------------------

function isGuestNick(nick) {
  return /^guest\d*$/i.test(String(nick ?? "").trim());
}

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
    /** When true (default on freeq hosts), refuse Guest* and reconnect for SASL. */
    this.requireAuth =
      opts.requireAuth ??
      (String(this.host).includes("freeq") || !!this.freeqSession);
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
    this.saslOk = false;
    this.saslFailed = false;
    this.nickInUseRetries = 0;
    this.reconnectTimer = undefined;
    this.watchdogTimer = undefined;
    /** @type {Map<string, { sessionId: string, at: number }>} */
    this.avByChannel = new Map();
    /** Pending waiters for av-state started: channel → resolve(sessionId)[] */
    this.avWaiters = new Map();
  }

  /** Reload freeq session from disk (rook login + sync may have refreshed it). */
  refreshSession() {
    const next = loadFreeqSession();
    if (next) {
      this.freeqSession = next;
      this.password = undefined;
      log(
        `freeq session ready → ${next.pds_url} as ${next.handle ?? next.did}`,
      );
    } else if (this.requireAuth) {
      log(
        "no freeq session on disk — will not join as Guest; fix with rook login + sync-freeq-session",
      );
    }
    return this.freeqSession;
  }

  nickMatchesPreferred(nick = this.nick) {
    return (
      String(nick ?? "").toLowerCase() ===
      String(this.preferredNick ?? "").toLowerCase()
    );
  }

  /**
   * After SASL (or 001), reclaim IRC_NICK if freeq assigned Guest* / ghost nick.
   * freeq: "Authenticate to reclaim" — send NICK preferred once authed.
   */
  reclaimPreferredNick(reason = "reclaim") {
    if (!this.preferredNick) return false;
    if (this.nickMatchesPreferred()) return false;
    if (!this.saslOk && !this.authDid) {
      log(
        `skip NICK ${this.preferredNick} (${reason}): not SASL-authed yet (current=${this.nick})`,
      );
      return false;
    }
    log(
      `${reason}: NICK ${this.preferredNick} (was ${this.nick}${this.authDid ? ` did=${this.authDid}` : ""})`,
    );
    this.raw(`NICK ${this.preferredNick}`);
    return true;
  }

  noteAvState(channel, sessionId, action) {
    const key = (channel || "").toLowerCase();
    if (!key || !sessionId) return;
    if (action === "started" || action === "joined") {
      this.avByChannel.set(key, { sessionId, at: Date.now() });
      const waiters = this.avWaiters.get(key) ?? [];
      for (const r of waiters) r(sessionId);
      this.avWaiters.delete(key);
    } else if (action === "ended") {
      this.avByChannel.delete(key);
    }
  }

  waitAvStarted(channel, timeoutMs = 8_000) {
    const key = channel.toLowerCase();
    const known = this.avByChannel.get(key);
    if (known?.sessionId) return Promise.resolve(known.sessionId);
    return new Promise((resolve, reject) => {
      const list = this.avWaiters.get(key) ?? [];
      const timer = setTimeout(() => {
        const cur = this.avWaiters.get(key) ?? [];
        this.avWaiters.set(
          key,
          cur.filter((fn) => fn !== onOk),
        );
        reject(new Error(`timeout waiting for av-state on ${channel}`));
      }, timeoutMs);
      const onOk = (id) => {
        clearTimeout(timer);
        resolve(id);
      };
      list.push(onOk);
      this.avWaiters.set(key, list);
    });
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
    log(`→ PRIVMSG ${target}: ${String(text).slice(0, 80)}`);
  }

  /**
   * freeq / IRCv3 reaction: TAGMSG with +react and +reply=<msgid>.
   * No-op when msgid is missing (plain IRC).
   */
  sendReact(target, emoji, msgid) {
    if (!target || !msgid || !emoji) return false;
    const e = escapeTagValue(emoji);
    const id = escapeTagValue(msgid);
    // freeq-webui / freeq-sdk: @+react=<emoji>;+reply=<msgid> TAGMSG <target>
    this.raw(`@+react=${e};+reply=${id} TAGMSG ${target}`);
    log(`→ REACT ${emoji} on ${msgid.slice(0, 24)}… in ${target}`);
    return true;
  }

  /** ACK that we accepted a mention and are working on it. */
  reactWorking(target, msgid) {
    if (!msgid) {
      log(`no msgid for working react on ${target}`);
      return false;
    }
    return this.sendReact(target, WORKING_REACT, msgid);
  }

  /**
   * Send an IRCv3 TAGMSG with client tags (e.g. freeq AV signaling).
   * @param {string} target
   * @param {Record<string, string>} tags  keys may include leading +
   */
  sendTagmsg(target, tags) {
    if (!target || !tags || !Object.keys(tags).length) return;
    const parts = [];
    for (const [k, v] of Object.entries(tags)) {
      if (v === "" || v === undefined || v === null) parts.push(k);
      else parts.push(`${k}=${escapeTagValue(String(v))}`);
    }
    this.raw(`@${parts.join(";")} TAGMSG ${target}`);
    log(`→ TAGMSG ${target} ${parts.join(";")}`);
  }

  avStart(channel, instance, title) {
    const tags = {
      "+freeq.at/av-start": "",
      "+freeq.at/av-instance": instance,
    };
    if (title) tags["+freeq.at/av-title"] = title;
    this.sendTagmsg(channel, tags);
  }

  avJoin(channel, sessionId, instance) {
    this.sendTagmsg(channel, {
      "+freeq.at/av-join": "",
      "+freeq.at/av-id": sessionId,
      "+freeq.at/av-instance": instance,
    });
  }

  avLeave(channel, sessionId, instance) {
    this.sendTagmsg(channel, {
      "+freeq.at/av-leave": "",
      "+freeq.at/av-id": sessionId,
      "+freeq.at/av-instance": instance,
    });
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

  forceReconnect(reason, delayMs = 2_000) {
    if (this.stopped) return;
    this.connecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.detachSockets(reason);
    this.scheduleReconnect(delayMs);
  }

  /** Alias used when we refuse Guest / SASL failure. */
  scheduleForcedReconnect(reason, delayMs = 5_000) {
    this.forceReconnect(reason, delayMs);
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
    // Always re-read session so a sync-freeq-session between reconnects is used.
    this.refreshSession();
    this.nick = this.preferredNick;
    this.authDid = null;
    this.saslOk = false;
    this.saslFailed = false;
    this.nickInUseRetries = 0;
    this.joined = false;
    log(
      `connect gen=${gen} → ${this.host}:${this.port} tls=${this.tls} as ${this.nick}` +
        (this.freeqSession
          ? ` (SASL ${this.freeqSession.did})`
          : " (no freeq session)"),
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
    // Prefer the configured nick from the first line — freeq binds SASL to
    // whatever NICK we hold; Guest rename only happens if SASL never succeeds.
    if (this.requireAuth && !this.freeqSession) {
      log(
        "abort register: need freeq SASL session for nick " +
          this.preferredNick +
          " (rook login + sync-freeq-session)",
      );
      try {
        this.raw("QUIT :waiting for freeq session");
      } catch {
        /* ignore */
      }
      this.scheduleForcedReconnect("no-session", 15_000);
      return;
    }
    this.nick = this.preferredNick;
    this.raw("CAP LS 302");
    this.raw(`NICK ${this.preferredNick}`);
    this.raw(`USER ${this.preferredNick} 0 * :eve irc-bridge`);
    log(`register CAP+NICK+USER as ${this.preferredNick}`);
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
    if (cmd === "900") {
      // RPL_LOGGEDIN — params often [nick, hostmask, account, text]
      const account = m.params[2];
      if (account) this.authDid = account;
      log(`logged in as ${account ?? m.params.join(" ")}`);
      return;
    }
    if (cmd === "903") {
      this.saslOk = true;
      this.saslFailed = false;
      log(`SASL success${this.authDid ? ` as ${this.authDid}` : ""}`);
      this.raw("CAP END");
      // freeq may still be holding a temporary nick until registration ends;
      // reclaim preferred as soon as we're authed (also again on 001).
      this.reclaimPreferredNick("post-sasl");
      return;
    }
    if (cmd === "904" || cmd === "905") {
      this.saslFailed = true;
      this.saslOk = false;
      log(`SASL failed (${cmd}): ${m.params[m.params.length - 1] ?? ""}`);
      this.raw("CAP END");
      if (this.requireAuth && this.freeqSession) {
        log(
          "SASL failed with freeq session present — disconnecting (will not stay as Guest)",
        );
        this.scheduleForcedReconnect("sasl-failed", 5_000);
      }
      return;
    }
    if (cmd === "433") {
      // freeq: trailing `_` is a reclaimable fallback after DID auth.
      // Random suffixes bind the wrong nick to the DID — avoid that.
      this.nickInUseRetries += 1;
      if (this.nickInUseRetries > 5) {
        log(`nick ${this.preferredNick} still in use after retries; reconnect`);
        this.scheduleForcedReconnect("nick-in-use", 8_000);
        return;
      }
      if (!this.saslOk && this.freeqSession) {
        const fallback = `${this.preferredNick}_`;
        this.nick = fallback;
        log(
          `nick in use pre-SASL; temporary ${fallback} (freeq reclaim after auth)`,
        );
        this.raw(`NICK ${fallback}`);
        return;
      }
      // Post-auth collision: re-try preferred a few times (ghost may die).
      log(
        `nick in use post-auth (try ${this.nickInUseRetries}); retry ${this.preferredNick}`,
      );
      setTimeout(() => {
        if (!this.stopped) this.raw(`NICK ${this.preferredNick}`);
      }, 1_500 * this.nickInUseRetries).unref?.();
      return;
    }
    if (cmd === "001") {
      // Server-assigned nick is authoritative (Guest rename has no NICK msg).
      const assigned = (m.params[0] ?? "").trim();
      if (assigned) this.nick = assigned;
      log(
        `welcome 001 nick=${this.nick} preferred=${this.preferredNick} sasl=${this.saslOk ? "ok" : this.saslFailed ? "fail" : "none"}`,
      );

      if (isGuestNick(this.nick) && this.requireAuth) {
        log(
          `assigned Guest nick ${this.nick} — refusing channel join; reconnect after session refresh`,
        );
        this.scheduleForcedReconnect("guest-nick", 6_000);
        return;
      }

      this.reclaimPreferredNick("post-welcome");
      this.raw(`JOIN ${this.channel}`);
      return;
    }
    if (cmd === "NICK") {
      const oldNick = nickFromPrefix(m.prefix);
      const newNick = (m.params[0] ?? "").replace(/^:/, "");
      if (
        oldNick &&
        newNick &&
        oldNick.toLowerCase() === String(this.nick).toLowerCase()
      ) {
        log(`self nick ${oldNick} → ${newNick}`);
        this.nick = newNick;
        if (this.nickMatchesPreferred()) {
          this.nickInUseRetries = 0;
          log(`preferred nick ${this.preferredNick} held`);
        }
      }
      return;
    }
    if (cmd === "NOTICE") {
      const text = m.params[m.params.length - 1] ?? "";
      // freeq: "Nick eve is registered — renamed to Guest12345. Authenticate…"
      const guestRename = text.match(/renamed to (Guest\d+)/i);
      if (guestRename) {
        this.nick = guestRename[1];
        log(`server force-renamed us to ${this.nick}: ${text.slice(0, 120)}`);
      }
      return;
    }
    if (
      cmd === "JOIN" &&
      nickFromPrefix(m.prefix).toLowerCase() === String(this.nick).toLowerCase()
    ) {
      const now = Date.now();
      this.joined = true;
      this.joinedAt = now;
      this.backlogActive = true;
      this.lastChannelMsgAt = now;
      this.backlogDropped = 0;
      if (!this.nickMatchesPreferred()) {
        log(
          `joined ${this.channel} as ${this.nick} (wanted ${this.preferredNick}) — reclaiming`,
        );
        this.reclaimPreferredNick("post-join");
      } else {
        log(
          `joined ${this.channel} as ${this.nick} (backlog min=${BACKLOG_MIN_MS} gap=${BACKLOG_GAP_MS} max=${BACKLOG_MAX_MS})`,
        );
      }
      return;
    }
    if (cmd === "PRIVMSG") {
      this.handlePrivmsg(
        nickFromPrefix(m.prefix),
        m.params[0] ?? "",
        m.params[1] ?? "",
        m.tags ?? {},
      );
      return;
    }
    if (cmd === "TAGMSG") {
      this.handleTagmsg(m.params[0] ?? "", m.tags ?? {});
    }
  }

  handleTagmsg(target, tags) {
    const state = tags["+freeq.at/av-state"];
    if (!state) return;
    const sessionId = tags["+freeq.at/av-id"] ?? "";
    log(`av-state ${state} ${target} id=${sessionId.slice(0, 16)}`);
    this.noteAvState(target, sessionId, state);
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
      // message-tags: receive msgid + send client-only tags (+react, +reply)
      for (const c of [
        "account-tag",
        "extended-join",
        "message-tags",
        "message-ids",
      ]) {
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

  handlePrivmsg(from, target, text, tags = {}) {
    if (from === this.nick) return;
    const msgid = tags.msgid || tags["draft/msgid"] || "";
    const isChannel = target.startsWith("#") || target.startsWith("&");
    if (isChannel) {
      if (this.shouldDropBacklog()) {
        this.lastChannelMsgAt = Date.now();
        this.backlogDropped += 1;
        return;
      }
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
      // Immediate 👀 so the user sees the bot accepted the mention.
      this.reactWorking(target, msgid);
      // Mention only — never attach channel scrollback. eve's SendPayload.context
      // becomes role:user history and models answer every historical line.
      log(
        `mention from ${from} in ${target}: ${body.slice(0, 80)} (msgid=${msgid ? msgid.slice(0, 16) : "-"})`,
      );
      this.onMessage(from, target, body, { msgid });
      return;
    }
    if (this.owners.size && !this.owners.has(from.toLowerCase())) {
      this.sendPrivmsg(from, "not authorized");
      return;
    }
    if (!text.trim()) return;
    this.reactWorking(from, msgid);
    this.onMessage(from, from, text.trim(), { msgid });
  }
}

// ---------------------------------------------------------------------------
// Eve HTTP: inbound POST + outbound SSE
// ---------------------------------------------------------------------------

async function postInbound(from, target, text, meta = {}) {
  const url = `${EVE_URL}${INBOUND_PATH}`;
  const payload = { from, target, text };
  if (meta.msgid) payload.msgid = meta.msgid;
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
const requireAuth =
  process.env.IRC_REQUIRE_AUTH === "0" ||
  process.env.IRC_REQUIRE_AUTH === "false"
    ? false
    : process.env.IRC_REQUIRE_AUTH === "1" ||
      process.env.IRC_REQUIRE_AUTH === "true" ||
      String(IRC_HOST).includes("freeq") ||
      !!freeqSession;

if (freeqSession) {
  log(`freeq session → ${freeqSession.pds_url} as ${freeqSession.handle}`);
} else if (requireAuth) {
  log(
    "no freeq session; bridge will refuse Guest and retry (rook login + sync-freeq-session)",
  );
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
  requireAuth,
  onMessage: (from, target, text, meta) => {
    void postInbound(from, target, text, meta);
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

// ---------------------------------------------------------------------------
// AV ensure + radio (orchestrates TAGMSG + eve-av-bridge)
// ---------------------------------------------------------------------------

function newAvInstance() {
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
}

async function discoverActiveSession(channel) {
  const encoded = encodeURIComponent(channel);
  const url = `${FREEQ_API_BASE}/api/v1/channels/${encoded}/sessions`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const json = await res.json();
    const active = json?.active;
    if (!active || active.state !== "Active") return null;
    return typeof active.id === "string" ? active.id : null;
  } catch (e) {
    log(`discover session failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** Fetch freeq session roster (authoritative nick/instance for MoQ paths). */
async function fetchSessionRoster(sessionId) {
  const url = `${FREEQ_API_BASE}/api/v1/sessions/${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`session roster HTTP ${res.status}`);
  return res.json();
}

/**
 * MoQ broadcast path MUST use the nick freeq recorded on the roster for our
 * instance — freeq clients subscribe via roster, not MoQ announce alone.
 * Publishing as `eve~x` while roster says `GuestN~x` → clients never hear us.
 */
async function rosterNickForInstance(sessionId, instance, fallbackNick) {
  for (let i = 0; i < 8; i++) {
    try {
      const data = await fetchSessionRoster(sessionId);
      const parts = Array.isArray(data?.participants) ? data.participants : [];
      const me = parts.find((p) => p?.instance_id === instance);
      if (me?.nick) {
        log(
          `roster nick for instance ${instance}: ${me.nick} (did=${me.did ?? "?"})`,
        );
        return String(me.nick);
      }
    } catch (e) {
      log(`roster poll: ${e instanceof Error ? e.message : e}`);
    }
    await sleep(250);
  }
  log(`roster nick missing for ${instance}; fallback ${fallbackNick}`);
  return fallbackNick;
}

/**
 * Ensure we are joined to an AV call on `channel`, connect media plane.
 * @returns {{ sessionId, instance, sfuUrl, channel, nick }}
 */
async function ensureAv(channel = IRC_CHANNEL, title = "eve radio") {
  const ch = channel.startsWith("#") ? channel : `#${channel}`;
  // freeq records the IRC nick at av_join time. Guest* nicks break MoQ mesh
  // (clients subscribe to GuestN~inst while we might publish eve~inst).
  if (/^guest/i.test(irc.nick)) {
    throw new Error(
      `IRC nick is ${irc.nick} (SASL guest) — fix freeq SASL so nick is eve before radio`,
    );
  }

  let sessionId = await discoverActiveSession(ch);
  const instance = newAvInstance();

  if (sessionId) {
    log(`av join existing ${sessionId} on ${ch} as ${irc.nick}~${instance}`);
    irc.avJoin(ch, sessionId, instance);
  } else {
    log(`av start on ${ch} as ${irc.nick}~${instance}`);
    const wait = irc.waitAvStarted(ch, 10_000);
    irc.avStart(ch, instance, title);
    sessionId = await wait;
    // start already joined us as initiator; still join if needed for presence
    irc.avJoin(ch, sessionId, instance);
  }

  // Authoritative nick from freeq roster (matches client subscribe paths).
  const nick = await rosterNickForInstance(sessionId, instance, irc.nick);
  if (/^guest/i.test(nick)) {
    throw new Error(
      `freeq roster has us as ${nick} — SASL not applied at join; refresh session and retry`,
    );
  }

  // Connect MoQ media on av-bridge — path = session/nick~instance
  const body = {
    sfu_url: SFU_URL_RESOLVED,
    session_id: sessionId,
    nick,
    instance,
    channel: ch,
    // Video tile for radio visualizer (ICY title + DSP waveform/spectrum).
    audio_only: false,
  };
  const res = await fetch(`${AV_BRIDGE_URL}/v1/session/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `av-bridge connect ${res.status}`);
  }

  log(
    `media path ${sessionId}/${nick}~${instance} (must match freeq roster for clients to hear)`,
  );

  return {
    sessionId,
    instance,
    sfuUrl: SFU_URL_RESOLVED,
    channel: ch,
    nick,
    broadcastPath: `${sessionId}/${nick}~${instance}`,
    session: json.session,
  };
}

async function playRadio({ url, channel, title }) {
  if (!url) throw new Error("url required");
  let av;
  try {
    av = await ensureAv(channel ?? IRC_CHANNEL, title ?? "eve radio");
  } catch (e) {
    // Media may already be up from a prior call; still try play.
    log(
      `ensureAv: ${e instanceof Error ? e.message : e}; trying radio play anyway`,
    );
    av = { channel: channel ?? IRC_CHANNEL, error: String(e) };
  }
  const res = await fetch(`${AV_BRIDGE_URL}/v1/radio/play`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `radio play ${res.status}`);
  }
  return { av, radio: json.radio };
}

async function stopRadio() {
  try {
    await fetch(`${AV_BRIDGE_URL}/v1/radio/stop`, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
  } catch (e) {
    log(`radio stop: ${e instanceof Error ? e.message : e}`);
  }
  return { ok: true };
}

// Minimal control HTTP for eve tools (loopback).
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

const controlServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${CONTROL_HOST}`);
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        nick: irc.nick,
        channel: IRC_CHANNEL,
        avBridge: AV_BRIDGE_URL,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/av/ensure") {
      const body = await readJson(req);
      const out = await ensureAv(body.channel, body.title);
      sendJson(res, 200, { ok: true, ...out });
      return;
    }
    if (req.method === "POST" && url.pathname === "/radio/play") {
      const body = await readJson(req);
      const out = await playRadio(body);
      sendJson(res, 200, { ok: true, ...out });
      return;
    }
    if (req.method === "POST" && url.pathname === "/radio/stop") {
      const out = await stopRadio();
      sendJson(res, 200, out);
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`control error: ${msg}`);
    sendJson(res, 500, { ok: false, error: msg });
  }
});

controlServer.listen(CONTROL_PORT, CONTROL_HOST, () => {
  log(`control HTTP http://${CONTROL_HOST}:${CONTROL_PORT} (radio/av)`);
});

await waitForEve();
irc.start();
// SSE loop in parallel (reconnects forever)
void runSseLoop(irc);

log(
  `running preferredNick=${IRC_NICK} channel=${IRC_CHANNEL} requireAuth=${requireAuth} eve=${EVE_URL} inbound=${INBOUND_PATH} out=${OUT_SSE_PATH} avBridge=${AV_BRIDGE_URL}`,
);
