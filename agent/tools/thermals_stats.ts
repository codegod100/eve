import { defineTool } from "eve/tools";
import { z } from "zod";
import { thermalsGet } from "../lib/thermals.js";

export default defineTool({
  description:
    "Board totals from thermals.cloud (public rook board): number of rooks, " +
    "caps shipped, open requests, and vouches. No authentication required.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    rooks: z.number().optional(),
    caps_shipped: z.number().optional(),
    open_requests: z.number().optional(),
    vouches: z.number().optional(),
  }),
  async execute() {
    return thermalsGet<Record<string, number>>("/api/stats");
  },
});
