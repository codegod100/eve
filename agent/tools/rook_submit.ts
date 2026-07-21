import { defineTool } from "eve/tools";
import { z } from "zod";
import { runRook } from "../lib/rook-cli.js";

export default defineTool({
  description:
    "Ship work as a rook: `rook submit <upstream>` runs fork → push → pr → ship " +
    "under one session. Use from a local clone (cwd) that has commits ready to push. " +
    "Optionally attach a thermals request at:// URI so the cap replies to that request. " +
    "Requires enrolled identity + login session (see rook_doctor). Destructive only " +
    "in the sense of publishing — does not force-push or delete.",
  inputSchema: z.object({
    upstream: z
      .string()
      .min(1)
      .describe(
        "Upstream repo URL to fork against (e.g. https://github.com/org/repo " +
          "or a tangled/knot URL).",
      ),
    cwd: z
      .string()
      .min(1)
      .describe(
        "Absolute path to the local git clone with the work ready to ship.",
      ),
    request: z
      .string()
      .optional()
      .describe(
        "Optional thermals request at:// URI from thermals_requests — " +
          "links the shipped cap as a reply to that request.",
      ),
    branch: z
      .string()
      .optional()
      .describe("Branch name to push (default: current / CLI default)."),
    identity: z.string().optional().describe("Optional identity.json path."),
  }),
  async execute({ upstream, cwd, request, branch, identity }) {
    const args = ["submit", upstream];
    if (request) args.push("--request", request);
    if (branch) args.push("--branch", branch);

    const result = await runRook(args, {
      identity,
      cwd,
      timeoutMs: 300_000,
    });

    if (!result.ok) {
      throw new Error(
        `rook submit failed: ${
          (result.data &&
            typeof result.data === "object" &&
            "error" in result.data &&
            String((result.data as { error: unknown }).error)) ||
          result.stderr ||
          result.stdout ||
          `exit ${result.exitCode}`
        }`,
      );
    }

    return {
      ok: true,
      result: result.data,
      stderr: result.stderr || undefined,
    };
  },
});
