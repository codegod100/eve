import { defineTool } from "eve/tools";
import { z } from "zod";
import { thermalsGet } from "../lib/thermals.js";

export default defineTool({
  description:
    "Fetch a single open work request from thermals.cloud by its at:// URI " +
    "(from thermals_requests). Returns full title, description, beacon, and " +
    "implementation counts. No auth required.",
  inputSchema: z.object({
    uri: z
      .string()
      .min(1)
      .describe(
        "AT URI of the request, e.g. at://did:plc:…/org.v-it.cap/… " +
          "(the uri field from thermals_requests).",
      ),
  }),
  async execute({ uri }) {
    if (!uri.startsWith("at://")) {
      throw new Error(`Expected an at:// URI, got: ${uri}`);
    }
    return thermalsGet<Record<string, unknown>>("/api/request", { uri });
  },
});
