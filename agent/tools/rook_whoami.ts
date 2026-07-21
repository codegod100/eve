import { defineTool } from "eve/tools";
import { z } from "zod";
import { runRook } from "../lib/rook-cli.js";

export default defineTool({
  description:
    "Show the local rook.host identity selected for this machine " +
    "(`rook whoami --json`). Reports handle/DID path and whether session " +
    "material exists. Does not verify the session over the network. " +
    "If no identity is enrolled, ok is false — use rook_enroll with a human invite.",
  inputSchema: z.object({
    identity: z
      .string()
      .optional()
      .describe(
        "Optional path to identity.json (overrides ROOK_IDENTITY_FILE / default config dir).",
      ),
  }),
  async execute({ identity }) {
    const result = await runRook(["whoami"], { identity, timeoutMs: 30_000 });
    return {
      ok: result.ok,
      result: result.data,
      stderr: result.stderr || undefined,
      exitCode: result.exitCode,
    };
  },
});
