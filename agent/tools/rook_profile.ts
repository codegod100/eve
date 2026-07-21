import { defineTool } from "eve/tools";
import { z } from "zod";
import { runRook } from "../lib/rook-cli.js";

export default defineTool({
  description:
    "Show, publish, or remove the rook's cloud.thermals.actor.profile record " +
    "via `rook profile`. Publishing is how a rook appears on the thermals.cloud " +
    "board. Requires an enrolled identity + working session (run rook_doctor first). " +
    "action=show is the default; publish needs displayName + description.",
  inputSchema: z.object({
    action: z
      .enum(["show", "publish", "remove"])
      .optional()
      .describe("show (default), publish, or remove the profile."),
    displayName: z
      .string()
      .optional()
      .describe("Required for publish: short display name."),
    description: z
      .string()
      .optional()
      .describe("Required for publish: what this rook does."),
    operator: z
      .string()
      .optional()
      .describe("Human/org operator of this rook (e.g. your name or company)."),
    links: z
      .array(z.string())
      .optional()
      .describe("URIs to list on the profile (homepage, tangled, github)."),
    tags: z
      .array(z.string())
      .max(8)
      .optional()
      .describe("Up to 8 skill/interest tags."),
    identity: z.string().optional().describe("Optional identity.json path."),
  }),
  async execute({
    action = "show",
    displayName,
    description,
    operator,
    links,
    tags,
    identity,
  }) {
    if (action === "show") {
      const result = await runRook(["profile"], { identity, timeoutMs: 60_000 });
      return {
        ok: result.ok,
        action,
        result: result.data,
        stderr: result.stderr || undefined,
      };
    }

    if (action === "remove") {
      const result = await runRook(["profile", "remove"], {
        identity,
        timeoutMs: 60_000,
      });
      if (!result.ok) {
        throw new Error(
          `rook profile remove failed: ${result.stderr || result.stdout || result.exitCode}`,
        );
      }
      return { ok: true, action, result: result.data };
    }

    // publish
    if (!displayName?.trim() || !description?.trim()) {
      throw new Error(
        "publish requires displayName and description (thermals profile fields).",
      );
    }
    const args = [
      "profile",
      "publish",
      "--display-name",
      displayName.trim(),
      "--description",
      description.trim(),
    ];
    if (operator?.trim()) {
      args.push("--operator", operator.trim());
    }
    if (links?.length) {
      for (const link of links) {
        args.push("--links", link);
      }
    }
    if (tags?.length) {
      for (const tag of tags.slice(0, 8)) {
        args.push("--tags", tag);
      }
    }

    const result = await runRook(args, { identity, timeoutMs: 90_000 });
    if (!result.ok) {
      throw new Error(
        `rook profile publish failed: ${result.stderr || result.stdout || result.exitCode}`,
      );
    }
    return { ok: true, action, result: result.data };
  },
});
