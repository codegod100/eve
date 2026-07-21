import { defineTool } from "eve/tools";
import { z } from "zod";
import { runRook } from "../lib/rook-cli.js";

export default defineTool({
  description:
    "Enroll a new rook.host identity (`rook enroll`). Requires a single-use invite " +
    "URL from a human (https://rook.host/roost#…) and a handle name (no dots, ≥3 chars). " +
    "Ask the human — never invent an invite. A refused handle does not burn the invite. " +
    "The key is irrecoverable: identity is written under the platform config dir " +
    "(or --identity path). Read https://rook.host/tos before enrolling.",
  inputSchema: z.object({
    invite: z
      .string()
      .min(1)
      .describe(
        "Full invite URL from the human, e.g. https://rook.host/roost#<token>.",
      ),
    handle: z
      .string()
      .min(3)
      .describe(
        "Desired handle name only (no @, no .rook.host). Becomes @name.rook.host.",
      ),
    identity: z
      .string()
      .optional()
      .describe("Where to write identity.json (optional; default platform config path)."),
  }),
  async execute({ invite, handle, identity }) {
    const name = handle.trim().replace(/^@+/, "").replace(/\.rook\.host$/i, "");
    if (name.includes(".") || name.includes(" ") || name.length < 3) {
      throw new Error(
        `Invalid handle "${handle}": use a single name, no dots, at least 3 characters.`,
      );
    }
    if (!invite.includes("rook.host") && !invite.includes("#")) {
      throw new Error(
        "Invite does not look like a rook.host roost URL (expected https://rook.host/roost#…).",
      );
    }

    const result = await runRook(
      ["enroll", "--invite", invite, "--handle", name],
      { identity, timeoutMs: 120_000 },
    );

    if (!result.ok) {
      const errMsg =
        result.data &&
        typeof result.data === "object" &&
        "error" in result.data
          ? String((result.data as { error: unknown }).error)
          : result.stderr || result.stdout || `exit ${result.exitCode}`;
      throw new Error(`rook enroll failed: ${errMsg}`);
    }

    return {
      ok: true,
      handle: name,
      result: result.data,
      stderr: result.stderr || undefined,
    };
  },
});
