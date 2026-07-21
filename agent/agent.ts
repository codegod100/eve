import { defineAgent } from "eve";
import { createOpenAI } from "@ai-sdk/openai";

// All API keys are fetched at boot from OpenBao (openbao.boxd.sh) by
// scripts/start.sh and injected into this process's env — never stored on disk.

// OpenCode's Zen model gateway hosts free-tier models on an OpenAI-compatible
// endpoint. .chat() forces Chat Completions; the default model() interface
// uses the Responses API, which Zen does not implement.
// https://opencode.ai/zen/v1
const opencode = createOpenAI({
  baseURL: process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/v1",
  apiKey: process.env.OPENCODE_API_KEY,
});

export default defineAgent({
  // north-mini-code-free — free tier on OpenCode Zen (hy3-free retired).
  model: opencode.chat("north-mini-code-free"),
  // OpenCode's /v1/models omits context_length; set the window so compaction
  // does not fail for this custom provider id.
  modelContextWindowTokens: 32_768,
});
