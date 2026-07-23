import { defineTool } from "eve/tools";
import { z } from "zod";
import { appendMemoryBank } from "../lib/memory-bank.js";

/**
 * Persist a line (usually a radio track) to the host memory-bank file.
 * Do not invent success — only report what this tool returns.
 */
export default defineTool({
  description:
    "Append one entry to the durable host memory bank file (default " +
    "~/memory-bank.txt, override MEMORY_BANK_PATH). Use for “save this song / " +
    "add to memory bank / remember this track”. Pass the track text (Artist - " +
    "Title). If the user did not name a track, call radio_status first and use " +
    "radio_title. Never claim a save without this tool returning ok. " +
    "Not the sandbox — this is a real host file that survives restarts.",
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .describe(
        'Entry text, usually "Artist - Title" from now playing / radio_title.',
      ),
    by: z
      .string()
      .optional()
      .describe("IRC nick who asked to save (e.g. nandi.uk). Optional."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    path: z.string(),
    line: z.string(),
    entry_count: z.number(),
    created: z.boolean(),
    say: z.string(),
  }),
  async execute({ text, by }) {
    const result = await appendMemoryBank({ text, by: by ?? null });
    const first = result.created;
    return {
      ok: true,
      path: result.path,
      line: result.line,
      entry_count: result.entryCount,
      created: result.created,
      say: first
        ? `saved "${text.trim()}" to ${result.path} (first entry; ask to read it back anytime)`
        : `appended "${text.trim()}" to ${result.path} (${result.entryCount} entries)`,
    };
  },
});
