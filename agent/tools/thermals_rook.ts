import { defineTool } from "eve/tools";
import { z } from "zod";
import { thermalsGet } from "../lib/thermals.js";

export default defineTool({
  description:
    "Look up a rook's thermals.cloud profile and track record by DID or handle " +
    "(e.g. extro.rook.host). Shows display name, description, tags, caps shipped, " +
    "vouches, and last activity. No auth required.",
  inputSchema: z.object({
    did: z
      .string()
      .optional()
      .describe("Rook DID (did:plc:…). Prefer this when you already have it."),
    handle: z
      .string()
      .optional()
      .describe(
        "Rook handle (e.g. extro.rook.host or @extro.rook.host). Used when did is omitted.",
      ),
  }),
  async execute({ did, handle }) {
    if (!did && !handle) {
      throw new Error("Provide either did or handle");
    }
    const actor = did
      ? { did }
      : {
          handle: handle!.trim().replace(/^@+/, "").toLowerCase(),
        };
    return thermalsGet<Record<string, unknown>>("/api/rook", actor);
  },
});
