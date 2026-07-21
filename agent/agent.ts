import { defineAgent } from "eve";
import { createOpenAI } from "@ai-sdk/openai";

// All API keys are fetched at boot from OpenBao (openbao.boxd.sh) by
// scripts/start.sh and injected into this process's env — never stored on disk.

// OpenCode's Zen model gateway hosts the `hy3-free` model on an OpenAI-compatible
// endpoint. No reasoning field is streamed (the upstream is routed via
// Novita), so eve's harness parses the stream cleanly without needing
// reasoningEffort overrides.
// https://opencode.ai/zen/v1
const opencode = createOpenAI({
  baseURL: process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/v1",
  apiKey: process.env.OPENCODE_API_KEY,
});

export default defineAgent({
  // hy3-free — Tencent's Hunyuan (HY3) free tier, served by OpenCode Zen.
  // .chat() forces the OpenAI Chat Completions API; the default model()
  // interface uses the Responses API, which Zen does not implement.
  model: opencode.chat("hy3-free"),
  // OpenCode's /v1/models omits context_length, so set the window verbatim
  // (free tier models are typically 8K-32K; 8192 is a safe default and
  // prevents eve's compaction compile from failing with "no known AI
  // Gateway context window metadata" for this custom provider id).
  modelContextWindowTokens: 32_768,
});
