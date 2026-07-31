/**
 * Slide mode — freeform AV caption card.
 *
 * Loop (repeats until exit):
 *   1. Wait for you to say/type something in the channel
 *   2. Show what you said on the freeq AV slide tile
 *   3. Wait for the next thing you say
 *
 * Does NOT speak your words back (TTS echo would re-enter the mic and loop).
 * Voice duplex is STT-only: listen + display.
 *
 * Env:
 *   GROK_VOICE  reserved if duplex is shared with other modes
 */
import {
  startVoiceSession,
  stopVoiceSession,
  voiceSessionStatus,
} from "../voice-bridge/session.mjs";

/** @typedef {"idle"|"awaiting"|"echoing"|"error"} SlideState */

export class SlideSession {
  /**
   * @param {{
   *   channel?: string,
   *   withVoice?: boolean,
   *   avBridgeUrl?: string,
   *   onLog?: (m: string) => void,
   *   say: (target: string, text: string) => void,
   *   onDone?: () => void,
   * }} opts
   */
  constructor(opts) {
    this.channel = opts.channel || "#test";
    this.withVoice = opts.withVoice !== false;
    this.avBridgeUrl = (
      opts.avBridgeUrl ||
      process.env.AV_BRIDGE_URL ||
      "http://127.0.0.1:8790"
    ).replace(/\/$/, "");
    this.onLog = opts.onLog || ((m) => console.log(`[slide] ${m}`));
    this.say = opts.say;
    this.onDone = opts.onDone || (() => {});

    /** @type {SlideState} */
    this.state = "idle";
    this.startedAt = null;
    this.lastError = null;
    this.lastAnswer = null;
    this.lastNick = null;
    this.echoCount = 0;
    this._busy = false;
    this._voiceOwned = false;
  }

  status() {
    return {
      state: this.state,
      live: this.state !== "idle" && this.state !== "error",
      mode: "echo",
      channel: this.channel,
      index: this.echoCount,
      total: null,
      question: null,
      phrase: null,
      awaiting: this.state === "awaiting",
      lastAnswer: this.lastAnswer,
      lastNick: this.lastNick,
      echoCount: this.echoCount,
      startedAt: this.startedAt,
      lastError: this.lastError,
      voice: voiceSessionStatus(),
    };
  }

  /**
   * @param {{ headline?: string, body?: string, footer?: string }} slide
   */
  async _showAvTile(slide) {
    try {
      const res = await fetch(`${this.avBridgeUrl}/v1/slide/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          headline: slide.headline || "",
          body: slide.body || "",
          footer: slide.footer || "",
        }),
        signal: AbortSignal.timeout(8_000),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) {
        this.onLog(
          `av tile: ${j.error || res.status} (join freeq AV to see slides)`,
        );
      } else {
        this.onLog(`av tile ok: ${(slide.headline || "").slice(0, 40)}`);
      }
    } catch (e) {
      this.onLog(`av tile failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  async _clearAvTile() {
    try {
      await fetch(`${this.avBridgeUrl}/v1/slide/clear`, {
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      /* ignore */
    }
  }

  async start() {
    if (this.state !== "idle" && this.state !== "error") {
      return this.status();
    }
    this.startedAt = Date.now();
    this.lastError = null;
    this.lastAnswer = null;
    this.lastNick = null;
    this.echoCount = 0;
    this._busy = false;

    if (this.withVoice) {
      const vs = voiceSessionStatus();
      // If duplex chat is already live, stop it — we need STT→slide, not free chat.
      if (vs.live) {
        try {
          await stopVoiceSession();
        } catch {
          /* ignore */
        }
      }
      try {
        await startVoiceSession({
          avBridgeUrl: this.avBridgeUrl,
          voice: process.env.GROK_VOICE || "eve",
          channel: this.channel,
          skipGreeting: true,
          autoRespond: false,
          instructions:
            "You are Eve running an AV caption card. When asked to transcribe, output only the user's words. Never speak or repeat them.",
          onLog: (m) => this.onLog(`voice: ${m}`),
          onUserTranscript: (text, meta) => {
            const nick = meta?.nick || "you";
            // Route spoken words into the same path as IRC text.
            this.handleAnswer(nick, text);
          },
        });
        this._voiceOwned = true;
      } catch (e) {
        this.onLog(
          `voice optional start failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    await this._showAvTile({
      headline: "CAPTION",
      body: "Say something…",
      footer: "speak in the freeq call — shown on this card only",
    });
    // Control notice only — captions stay on AV tile, no IRC dump, no TTS.
    this.say(
      this.channel,
      `slide captions on (AV only) — speak in the call; i show it on the card (no voice echo). eve: exit slide mode to quit.`,
    );
    this.state = "awaiting";
    this.onLog("awaiting first utterance (display only, no TTS)");
    return this.status();
  }

  async stop(reason = "stop") {
    if (this.state === "idle") return this.status();
    this.state = "idle";
    this._busy = false;
    await this._clearAvTile();
    this.say(this.channel, `slide captions off (${reason}).`);
    if (this._voiceOwned) {
      try {
        await stopVoiceSession();
      } catch {
        /* ignore */
      }
      this._voiceOwned = false;
    }
    this.onDone();
    return this.status();
  }

  /**
   * @param {string} from nick
   * @param {string} answer
   * @returns {boolean} true if consumed
   */
  handleAnswer(from, answer) {
    if (this.state !== "awaiting" || this._busy) return false;
    const text = String(answer ?? "").trim();
    if (!text) return false;
    if (
      /^(?:enter|exit|leave|stop|end|start|skip)\s+slide/i.test(text) ||
      /^(?:slide\s+(?:mode\s+)?(?:on|off|status)|next\s+slide|skip|echo\s+(?:on|off|test))\b/i.test(
        text,
      )
    ) {
      return false;
    }

    this._busy = true;
    this.state = "echoing";
    this.lastAnswer = text;
    this.lastNick = from;
    void this._echo(from, text);
    return true;
  }

  /** No phrase deck — skip is a no-op that re-prompts. */
  async skip() {
    if (this.state !== "awaiting") return this.status();
    return this.status();
  }

  /**
   * @param {string} from
   * @param {string} text
   */
  async _echo(from, text) {
    try {
      this.echoCount += 1;
      const n = this.echoCount;
      const line = text.slice(0, 400);

      // Display only — never TTS. Speaking the transcript re-enters the mic and loops.
      await this._showAvTile({
        headline: `YOU SAID  #${n}`,
        body: line,
        footer: from,
      });

      // Ready for next
      this.state = "awaiting";
      this._busy = false;
      this.onLog(`caption #${n} from ${from}: ${line.slice(0, 60)}`);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.onLog(`caption error: ${this.lastError}`);
      this._busy = false;
      this.state = "awaiting";
    }
  }
}

/** @type {SlideSession | null} */
let active = null;

export function getActiveSlideSession() {
  return active;
}

export function slideSessionStatus() {
  if (!active) {
    return {
      state: "idle",
      live: false,
      mode: "echo",
      channel: null,
      index: 0,
      total: null,
      question: null,
      phrase: null,
      awaiting: false,
      echoCount: 0,
    };
  }
  return active.status();
}

/**
 * @param {ConstructorParameters<typeof SlideSession>[0]} opts
 */
export async function startSlideSession(opts) {
  if (active && active.status().live) {
    return active.status();
  }
  if (active) {
    await active.stop("restart").catch(() => {});
  }
  active = new SlideSession({
    ...opts,
    onDone: () => {
      active = null;
      opts.onDone?.();
    },
  });
  try {
    return await active.start();
  } catch (e) {
    active = null;
    throw e;
  }
}

export async function stopSlideSession(reason = "stop") {
  if (!active) {
    return { state: "idle", live: false, mode: "echo" };
  }
  const st = await active.stop(reason);
  active = null;
  return st;
}

/**
 * @param {string} from
 * @param {string} answer
 */
export function feedSlideAnswer(from, answer) {
  if (!active) return false;
  return active.handleAnswer(from, answer);
}

export async function skipSlide() {
  if (!active) return { state: "idle", live: false, mode: "echo" };
  return active.skip();
}
