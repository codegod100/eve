import { defineAgent } from "eve";
import { createOpenAI } from "@ai-sdk/openai";

// All API keys are fetched at boot from OpenBao (openbao.boxd.sh) by
// scripts/start.sh and injected into this process's env — never stored on disk.

// Cloudflare Workers AI hosts GLM-5.2 on an OpenAI-compatible endpoint scoped
// to one account. .chat() forces Chat Completions; the default model()
// interface uses the Responses API, which this endpoint does not implement.
// https://developers.cloudflare.com/workers-ai/models/glm-5.2/
const cloudflare = createOpenAI({
  baseURL:
    process.env.CLOUDFLARE_AI_BASE_URL ??
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
  apiKey: process.env.CLOUDFLARE_API_TOKEN,
});

export default defineAgent({
  // @cf/zai-org/glm-5.2 — Z.ai's agentic-coding model on Workers AI.
  model: cloudflare.chat(process.env.CLOUDFLARE_AI_MODEL ?? "@cf/zai-org/glm-5.2"),
  // GLM-5.2 ships a 262,144-token context window.
  modelContextWindowTokens: 262_144,
});
