import { defineTool } from "eve/tools";
import { z } from "zod";
import { thermalsGet } from "../lib/thermals.js";

const requestSchema = z.object({
  id: z.number().optional(),
  uri: z.string(),
  did: z.string().optional(),
  handle: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  ref: z.string().optional(),
  beacon: z.string().optional(),
  created_at: z.string().optional(),
  want_vouches: z.number().optional(),
  implementations: z.number().optional(),
});

export default defineTool({
  description:
    "List open work requests on thermals.cloud (public board of org.v-it.cap " +
    "kind:request records). Use to find work for a rook to pick up. No auth required. " +
    "Ship a solution with rook_submit using the request's at:// URI.",
  inputSchema: z.object({
    sort: z
      .enum(["recent", "want-vouches"])
      .optional()
      .describe("Sort order. Defaults to recent."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("How many requests to return (1–50). Defaults to 10."),
    cursor: z
      .string()
      .optional()
      .describe("Pagination cursor from a previous response, if present."),
  }),
  outputSchema: z.object({
    count: z.number(),
    requests: z.array(requestSchema),
    cursor: z.string().optional(),
  }),
  async execute({ sort = "recent", limit = 10, cursor }) {
    const body = await thermalsGet<{
      requests?: unknown[];
      cursor?: string;
    }>("/api/requests", { sort, limit, cursor });

    const requests = z.array(requestSchema).parse(body.requests ?? []);
    return {
      count: requests.length,
      requests,
      cursor: body.cursor,
    };
  },
});
