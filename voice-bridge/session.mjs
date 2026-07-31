/**
 * Grok Voice (Eve) ↔ freeq eve-av-bridge duplex session.
 *
 * freeq AV utterances (VAD, f32 @ 16 kHz) → Cloudflare Workers AI
 * `xai/grok-voice` → PCM16 → speak_pcm back into the freeq call.
 *
 * Env:
 *   CLOUDFLARE_ACCOUNT_ID  (required)
 *   CLOUDFLARE_API_TOKEN   (required)
 *   GROK_VOICE             (default "eve")
 *   GROK_VOICE_MODEL       (default "xai/grok-voice")
 *   AV_BRIDGE_URL          (default http://127.0.0.1:8790)
 */
import WebSocket from "ws";

const DEFAULT_AV = "http://127.0.0.1:8790";
const DEFAULT_VOICE = "eve";
const DEFAULT_MODEL = "xai/grok-voice";
const OUT_RATE = 24_000;
const IN_RATE = 16_000;

/** @typedef {"idle"|"connecting"|"live"|"stopping"|"error"} VoiceState */

/**
 * @param {string} httpUrl
 * @returns {string}
 */
function httpToWs(httpUrl) {
  const u = new URL(httpUrl.replace(/\/$/, ""));
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.search = "";
  u.hash = "";
  return u.toString();
}

/**
 * @param {Float32Array | number[]} f32
 * @returns {Buffer} pcm16 LE
 */
function f32ToPcm16(f32) {
  const out = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    let s = f32[i];
    if (!Number.isFinite(s)) s = 0;
    s = Math.max(-1, Math.min(1, s));
    out.writeInt16LE((s * 32767) | 0, i * 2);
  }
  return out;
}

/**
 * @param {Buffer} pcm16
 * @returns {Float32Array}
 */
function pcm16ToF32(pcm16) {
  const n = Math.floor(pcm16.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = pcm16.readInt16LE(i * 2) / 32768;
  }
  return out;
}

/**
 * @param {Float32Array} f32
 * @returns {string}
 */
function f32ToB64(f32) {
  const bytes = Buffer.alloc(f32.length * 4);
  for (let i = 0; i < f32.length; i++) {
    bytes.writeFloatLE(f32[i], i * 4);
  }
  return bytes.toString("base64");
}

/**
 * Decode base64 f32 LE from av-bridge utterance.
 * @param {string} b64
 * @returns {Float32Array}
 */
function b64ToF32(b64) {
  const buf = Buffer.from(b64, "base64");
  const n = Math.floor(buf.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = buf.readFloatLE(i * 4);
  }
  return out;
}

export class VoiceSession {
  /**
   * @param {{
   *   avBridgeUrl?: string,
   *   accountId?: string,
   *   token?: string,
   *   voice?: string,
   *   model?: string,
   *   instructions?: string,
   *   channel?: string,
   *   onLog?: (msg: string) => void,
   *   onState?: (state: VoiceState, detail?: string) => void,
   *   skipGreeting?: boolean,
   *   autoRespond?: boolean,
   *   onUserTranscript?: (text: string, meta?: { nick?: string }) => void,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.avBridgeUrl = (opts.avBridgeUrl || process.env.AV_BRIDGE_URL || DEFAULT_AV).replace(
      /\/$/,
      "",
    );
    this.accountId =
      opts.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || "";
    this.token = opts.token || process.env.CLOUDFLARE_API_TOKEN || "";
    this.voice = opts.voice || process.env.GROK_VOICE || DEFAULT_VOICE;
    this.model = opts.model || process.env.GROK_VOICE_MODEL || DEFAULT_MODEL;
    this.instructions =
      opts.instructions ||
      process.env.GROK_VOICE_INSTRUCTIONS ||
      "You are Eve — energetic, warm, and helpful. Keep spoken replies short and clear. You are talking over a live freeq voice call.";
    this.channel = opts.channel || "#test";
    this.onLog = opts.onLog || ((m) => console.log(`[voice] ${m}`));
    this.onState = opts.onState || (() => {});
    /** When false, utterances are transcribed (text) and passed to onUserTranscript — no free chat reply. */
    this.autoRespond = opts.autoRespond !== false;
    /** @type {((text: string, meta?: { nick?: string }) => void) | null} */
    this.onUserTranscript = opts.onUserTranscript || null;

    /** @type {VoiceState} */
    this.state = "idle";
    /** @type {import("ws").WebSocket | null} */
    this.avWs = null;
    /** @type {import("ws").WebSocket | null} */
    this.grokWs = null;
    this.startedAt = null;
    this.lastError = null;
    this.stats = {
      utterances: 0,
      responses: 0,
      audioChunksOut: 0,
      bytesOut: 0,
    };
    this._closing = false;
    this._responseBusy = false;
    this._pendingCommit = false;
    /** @type {{ resolve: () => void, reject: (e: Error) => void, timer: NodeJS.Timeout } | null} */
    this._speakWait = null;
    /** When true, start() skips the default voice-mode greeting. */
    this.skipGreeting = Boolean(opts.skipGreeting);
    /** Collect text for a STT-only response.create (echo / slide mode). */
    this._sttBuf = "";
    this._sttActive = false;
    this._sttNick = null;
  }

  /**
   * @returns {{
   *   state: VoiceState,
   *   voice: string,
   *   channel: string,
   *   startedAt: number | null,
   *   lastError: string | null,
   *   stats: object,
   *   live: boolean,
   * }}
   */
  status() {
    return {
      state: this.state,
      voice: this.voice,
      channel: this.channel,
      startedAt: this.startedAt,
      lastError: this.lastError,
      stats: { ...this.stats },
      live: this.state === "live",
    };
  }

  /**
   * @param {VoiceState} state
   * @param {string} [detail]
   */
  _setState(state, detail) {
    this.state = state;
    if (detail) this.onLog(`${state}: ${detail}`);
    else this.onLog(state);
    try {
      this.onState(state, detail);
    } catch {
      /* ignore */
    }
  }

  async start() {
    if (this.state === "live" || this.state === "connecting") {
      return this.status();
    }
    if (!this.accountId || !this.token) {
      const err =
        "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN required for Grok Voice";
      this.lastError = err;
      this._setState("error", err);
      throw new Error(err);
    }

    this._closing = false;
    this.lastError = null;
    this._setState("connecting", `voice=${this.voice} av=${this.avBridgeUrl}`);

    try {
      await this._connectAv();
      await this._connectGrok();
      this.startedAt = Date.now();
      this._setState("live", `eve voice (${this.voice}) on freeq AV`);
      // Kick a short spoken greeting (no user audio yet) unless host wants silence.
      if (!this.skipGreeting) {
        this._requestGreeting();
      }
      return this.status();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.lastError = msg;
      this._setState("error", msg);
      await this.stop().catch(() => {});
      throw e;
    }
  }

  async stop() {
    if (this.state === "idle") return this.status();
    this._closing = true;
    this._setState("stopping");
    try {
      if (this.avWs && this.avWs.readyState === WebSocket.OPEN) {
        try {
          this.avWs.send(JSON.stringify({ type: "speak_clear" }));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    this._closeWs(this.grokWs);
    this._closeWs(this.avWs);
    this.grokWs = null;
    this.avWs = null;
    this.startedAt = null;
    this._responseBusy = false;
    this._setState("idle");
    return this.status();
  }

  /** @param {import("ws").WebSocket | null} ws */
  _closeWs(ws) {
    if (!ws) return;
    try {
      ws.removeAllListeners();
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close();
      }
    } catch {
      /* ignore */
    }
  }

  _connectAv() {
    const url = httpToWs(this.avBridgeUrl);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.avWs = ws;
      const t = setTimeout(() => {
        reject(new Error(`av-bridge WS timeout (${url})`));
        this._closeWs(ws);
      }, 10_000);

      ws.on("open", () => {
        clearTimeout(t);
        this.onLog(`av-bridge open ${url}`);
        resolve();
      });
      ws.on("message", (data) => this._onAvMessage(data));
      ws.on("error", (err) => {
        clearTimeout(t);
        const msg = err?.message || String(err);
        this.onLog(`av-bridge error: ${msg}`);
        if (this.state === "connecting") reject(new Error(msg));
        else if (!this._closing) {
          this.lastError = msg;
          this._setState("error", msg);
        }
      });
      ws.on("close", () => {
        this.onLog("av-bridge closed");
        if (!this._closing && this.state === "live") {
          this.lastError = "av-bridge disconnected";
          this._setState("error", "av-bridge disconnected");
        }
      });
    });
  }

  _connectGrok() {
    const model = encodeURIComponent(this.model);
    const url = `wss://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run?model=${model}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      this.grokWs = ws;
      let configured = false;
      const t = setTimeout(() => {
        if (!configured) {
          reject(new Error("grok-voice WS timeout"));
          this._closeWs(ws);
        }
      }, 15_000);

      ws.on("open", () => {
        this.onLog("grok-voice open");
        // Nested audio.output.voice is what Cloudflare session.updated confirms.
        ws.send(
          JSON.stringify({
            type: "session.update",
            session: {
              voice: this.voice,
              modalities: ["audio", "text"],
              instructions: this.instructions,
              output_audio_format: "pcm16",
              input_audio_format: "pcm16",
              turn_detection: null,
              // Prefer server-side STT when available (xAI / OpenAI realtime shape).
              input_audio_transcription: { model: "grok-transcribe" },
              audio: {
                input: {
                  format: { type: "audio/pcm", rate: IN_RATE },
                  transcription: { model: "grok-transcribe" },
                },
                output: {
                  voice: this.voice,
                  format: { type: "audio/pcm", rate: OUT_RATE },
                },
              },
            },
          }),
        );
      });

      ws.on("message", (data) => {
        let msg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (
          !configured &&
          (msg.type === "session.updated" || msg.type === "session.created")
        ) {
          const v =
            msg.session?.audio?.output?.voice ||
            msg.session?.voice ||
            this.voice;
          if (msg.type === "session.updated") {
            configured = true;
            clearTimeout(t);
            this.onLog(`grok session ready voice=${v}`);
            resolve();
          }
        }
        this._onGrokMessage(msg);
      });

      ws.on("error", (err) => {
        clearTimeout(t);
        const msg = err?.message || String(err);
        this.onLog(`grok-voice error: ${msg}`);
        if (!configured) reject(new Error(msg));
        else if (!this._closing) {
          this.lastError = msg;
          this._setState("error", msg);
        }
      });

      ws.on("close", (code, reason) => {
        this.onLog(`grok-voice closed ${code} ${reason || ""}`);
        if (!this._closing && this.state === "live") {
          this.lastError = `grok-voice closed (${code})`;
          this._setState("error", this.lastError);
        }
      });
    });
  }

  _requestGreeting() {
    if (!this.grokWs || this.grokWs.readyState !== WebSocket.OPEN) return;
    this._responseBusy = true;
    this.grokWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            "Greet briefly in one short sentence: you are Eve, voice mode is on, join the freeq voice call and talk to me.",
        },
      }),
    );
  }

  /** @param {import("ws").RawData} data */
  _onAvMessage(data) {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === "error") {
      this.onLog(`av error: ${msg.message || JSON.stringify(msg)}`);
      return;
    }
    if (msg.type === "utterance") {
      this._handleUtterance(msg);
    }
  }

  /**
   * @param {{ nick?: string, sample_rate?: number, pcm_f32_le_b64?: string, duration_ms?: number }} msg
   */
  _handleUtterance(msg) {
    if (this.state !== "live") return;
    if (!this.grokWs || this.grokWs.readyState !== WebSocket.OPEN) return;
    if (!msg.pcm_f32_le_b64) return;

    // Barge-in: stop current TTS in the call.
    if (this.avWs?.readyState === WebSocket.OPEN) {
      try {
        this.avWs.send(JSON.stringify({ type: "speak_clear" }));
      } catch {
        /* ignore */
      }
    }
    if (this._responseBusy) {
      try {
        this.grokWs.send(JSON.stringify({ type: "response.cancel" }));
      } catch {
        /* ignore */
      }
      this._responseBusy = false;
      this._sttActive = false;
      this._sttBuf = "";
    }

    const f32 = b64ToF32(msg.pcm_f32_le_b64);
    if (f32.length < 400) return; // ~25ms @16k — drop clicks
    const pcm16 = f32ToPcm16(f32);
    const b64 = pcm16.toString("base64");
    this.stats.utterances += 1;
    const nick = msg.nick || "?";
    this.onLog(
      `utterance from ${nick} ${msg.duration_ms || "?"}ms samples=${f32.length}`,
    );

    try {
      this.grokWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: b64,
        }),
      );
      this.grokWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      this._responseBusy = true;

      if (this.autoRespond) {
        // Free chat duplex
        this.grokWs.send(
          JSON.stringify({
            type: "response.create",
            response: { modalities: ["audio", "text"] },
          }),
        );
      } else {
        // STT-only path for slide/echo: get text, hand off to onUserTranscript
        this._sttBuf = "";
        this._sttActive = true;
        this._sttNick = nick;
        this.grokWs.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["text"],
              instructions:
                "Transcribe the user's last speech exactly. Output ONLY the words they said. No quotes, no labels, no extra commentary.",
            },
          }),
        );
      }
    } catch (e) {
      this.onLog(`send utterance failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * @param {string} text
   * @param {string} [nick]
   */
  _emitUserTranscript(text, nick) {
    const t = String(text || "")
      .trim()
      .replace(/^["'“”]+|["'“”]+$/g, "");
    if (!t) return;
    this.onLog(`user transcript (${nick || "?"}): ${t.slice(0, 120)}`);
    if (typeof this.onUserTranscript === "function") {
      try {
        this.onUserTranscript(t, { nick: nick || undefined });
      } catch (e) {
        this.onLog(
          `onUserTranscript error: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }

  /** @param {any} msg */
  _onGrokMessage(msg) {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "error") {
      const err =
        msg.error?.message || msg.message || JSON.stringify(msg).slice(0, 200);
      this.onLog(`grok error: ${err}`);
      this.lastError = err;
      // Don't leave STT hanging
      if (this._sttActive) {
        this._sttActive = false;
        this._sttBuf = "";
        this._responseBusy = false;
      }
      return;
    }

    // Official input STT events (if server emits them)
    if (
      msg.type === "conversation.item.input_audio_transcription.completed" ||
      msg.type === "conversation.item.input_audio_transcription.done"
    ) {
      const t = msg.transcript || msg.text || "";
      if (t && !this.autoRespond) {
        this._emitUserTranscript(t, this._sttNick || undefined);
        // If we were also doing a STT response.create, cancel it to avoid double echo
        if (this._sttActive && this.grokWs?.readyState === WebSocket.OPEN) {
          try {
            this.grokWs.send(JSON.stringify({ type: "response.cancel" }));
          } catch {
            /* ignore */
          }
          this._sttActive = false;
          this._sttBuf = "";
          this._responseBusy = false;
        }
      }
      return;
    }

    // Collect STT text deltas
    if (this._sttActive) {
      if (
        msg.type === "response.output_text.delta" ||
        msg.type === "response.text.delta" ||
        msg.type === "response.output_audio_transcript.delta" ||
        msg.type === "response.audio_transcript.delta"
      ) {
        this._sttBuf += msg.delta || "";
        return;
      }
      if (
        msg.type === "response.output_text.done" ||
        msg.type === "response.text.done"
      ) {
        if (msg.text) this._sttBuf = msg.text;
      }
    } else {
      if (
        msg.type === "response.output_audio_transcript.delta" ||
        msg.type === "response.audio_transcript.delta"
      ) {
        const d = msg.delta || "";
        if (d) this.onLog(`transcript: ${d}`);
      }
    }

    // Only play model audio when not in STT-only mode (and not mid-speak wait is fine)
    if (
      !this._sttActive &&
      (msg.type === "response.output_audio.delta" ||
        msg.type === "response.audio.delta")
    ) {
      const b64 = msg.delta || msg.audio;
      if (!b64) return;
      this._speakPcm16B64(b64);
    }

    if (msg.type === "response.done") {
      this._responseBusy = false;
      this.stats.responses += 1;
      if (this._sttActive) {
        const text = this._sttBuf;
        const nick = this._sttNick;
        this._sttActive = false;
        this._sttBuf = "";
        this._sttNick = null;
        if (text) this._emitUserTranscript(text, nick || undefined);
      }
      if (this._speakWait) {
        const w = this._speakWait;
        this._speakWait = null;
        clearTimeout(w.timer);
        w.resolve();
      }
    }
  }

  /**
   * Speak an exact line via Grok Voice TTS into freeq AV.
   * Resolves when response.done arrives (or timeout).
   * @param {string} text
   * @param {{ timeoutMs?: number }} [opts]
   */
  speakText(text, opts = {}) {
    const line = String(text ?? "").trim();
    if (!line) return Promise.resolve();
    if (this.state !== "live" || !this.grokWs || this.grokWs.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("voice session not live"));
    }

    // Cancel in-flight speech so slides don't overlap.
    if (this._responseBusy) {
      try {
        this.grokWs.send(JSON.stringify({ type: "response.cancel" }));
      } catch {
        /* ignore */
      }
      this._responseBusy = false;
    }
    if (this.avWs?.readyState === WebSocket.OPEN) {
      try {
        this.avWs.send(JSON.stringify({ type: "speak_clear" }));
      } catch {
        /* ignore */
      }
    }
    if (this._speakWait) {
      const prev = this._speakWait;
      this._speakWait = null;
      clearTimeout(prev.timer);
      prev.resolve();
    }

    const timeoutMs = opts.timeoutMs ?? 45_000;
    const escaped = line.replace(/"/g, "'").slice(0, 500);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._speakWait) {
          this._speakWait = null;
          this._responseBusy = false;
          resolve(); // don't fail the game on TTS timeout
        }
      }, timeoutMs);
      this._speakWait = { resolve, reject, timer };
      this._responseBusy = true;
      try {
        this.grokWs.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              instructions: `Say exactly this, then stop. Do not add extra words: ${escaped}`,
            },
          }),
        );
      } catch (e) {
        clearTimeout(timer);
        this._speakWait = null;
        this._responseBusy = false;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** @param {string} b64 pcm16 */
  _speakPcm16B64(b64) {
    if (!this.avWs || this.avWs.readyState !== WebSocket.OPEN) return;
    const pcm16 = Buffer.from(b64, "base64");
    if (pcm16.length < 2) return;
    const f32 = pcm16ToF32(pcm16);
    const pcm_f32_le_b64 = f32ToB64(f32);
    this.stats.audioChunksOut += 1;
    this.stats.bytesOut += pcm16.length;
    try {
      this.avWs.send(
        JSON.stringify({
          type: "speak_pcm",
          pcm_f32_le_b64,
          sample_rate: OUT_RATE,
        }),
      );
    } catch (e) {
      this.onLog(`speak_pcm failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** Singleton used by irc-bridge. */
let active = /** @type {VoiceSession | null} */ (null);

export function getActiveVoiceSession() {
  return active;
}

/**
 * @param {ConstructorParameters<typeof VoiceSession>[0]} opts
 */
/**
 * @param {ConstructorParameters<typeof VoiceSession>[0] & { skipGreeting?: boolean }} [opts]
 */
export async function startVoiceSession(opts = {}) {
  if (active && (active.state === "live" || active.state === "connecting")) {
    return active.status();
  }
  if (active) {
    await active.stop().catch(() => {});
  }
  active = new VoiceSession(opts);
  try {
    return await active.start();
  } catch (e) {
    active = null;
    throw e;
  }
}

export async function stopVoiceSession() {
  if (!active) {
    return { state: "idle", live: false, voice: DEFAULT_VOICE };
  }
  const st = await active.stop();
  active = null;
  return st;
}

export function voiceSessionStatus() {
  if (!active) {
    return {
      state: "idle",
      live: false,
      voice: process.env.GROK_VOICE || DEFAULT_VOICE,
      channel: null,
      startedAt: null,
      lastError: null,
      stats: null,
    };
  }
  return active.status();
}
