import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  listMemoryBank,
  memoryBankExists,
  memoryBankPath,
} from "../lib/memory-bank.js";

/**
 * Read entries from the host memory-bank file.
 */
export default defineTool({
  description:
    "List entries in the durable host memory bank (default ~/memory-bank.txt). " +
    "Use for “what’s in the memory bank / read it back / list saved songs”. " +
    "Never invent entries — only report what this tool returns. Empty means " +
    "the file is missing or has no lines yet.",
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Max entries to return from the end (most recent). Default all."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    path: z.string(),
    exists: z.boolean(),
    entry_count: z.number(),
    entries: z.array(
      z.object({
        at: z.string(),
        by: z.string().nullable(),
        text: z.string(),
        line: z.string(),
      }),
    ),
    say: z.string(),
  }),
  async execute({ limit }) {
    const path = memoryBankPath();
    const exists = await memoryBankExists(path);
    const entries = await listMemoryBank({ path, limit });
    if (!exists || entries.length === 0) {
      return {
        ok: true,
        path,
        exists,
        entry_count: 0,
        entries: [],
        say: exists
          ? `memory bank at ${path} is empty`
          : `no memory bank file yet at ${path}`,
      };
    }
    const preview = entries
      .map((e, i) => `${i + 1}) ${e.text}`)
      .join("; ");
    return {
      ok: true,
      path,
      exists,
      entry_count: entries.length,
      entries,
      say: `${entries.length} entr${entries.length === 1 ? "y" : "ies"} in ${path}: ${preview}`,
    };
  },
});
