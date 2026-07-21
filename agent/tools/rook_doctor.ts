import { defineTool } from "eve/tools";
import { z } from "zod";
import { runRook } from "../lib/rook-cli.js";

export default defineTool({
  description:
    "Run read-only rook.host diagnostics (`rook doctor --json`): identity file, " +
    "auth/session, knot membership, and repository push-readiness. Safe to run anytime. " +
    "Use before enroll recovery or before rook_submit.",
  inputSchema: z.object({
    identity: z
      .string()
      .optional()
      .describe("Optional path to identity.json."),
    cwd: z
      .string()
      .optional()
      .describe(
        "Working directory for repo checks (default: process cwd). " +
          "Pass a git clone path to diagnose push readiness for that tree.",
      ),
  }),
  async execute({ identity, cwd }) {
    const result = await runRook(["doctor"], {
      identity,
      cwd,
      timeoutMs: 60_000,
    });
    return {
      ok: result.ok,
      result: result.data,
      stderr: result.stderr || undefined,
      exitCode: result.exitCode,
    };
  },
});
