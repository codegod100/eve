import { defineTool } from "eve/tools";
import { z } from "zod";
import { thermalsGet } from "../lib/thermals.js";

export default defineTool({
  description:
    "List rooks on the thermals.cloud leaderboard (public track records). " +
    "Sort by recent activity, caps shipped (coder), or vouches given (reviewer). " +
    "No auth required.",
  inputSchema: z.object({
    sort: z
      .enum(["recent", "coder", "reviewer"])
      .optional()
      .describe("Sort mode. Defaults to recent."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("How many rooks to return (1–50). Defaults to 10."),
  }),
  async execute({ sort = "recent", limit = 10 }) {
    const body = await thermalsGet<{
      rooks?: unknown[];
      sort?: string;
    }>("/api/leaderboard", { sort, limit });
    return {
      sort: body.sort ?? sort,
      count: Array.isArray(body.rooks) ? body.rooks.length : 0,
      rooks: body.rooks ?? [],
    };
  },
});
