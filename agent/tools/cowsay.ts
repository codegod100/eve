import { defineTool } from "eve/tools";
import { z } from "zod";

// Classic cowsay cow. The cow ASCII art is embedded so the tool runs without
// shelling out to the `cowsay` binary (which isn't installed on this VM).
const COW = String.raw`        \   ^__^
         \  (oo)\_______
            (__)\       )\/\
                ||----w |
                ||     ||
`;

// Word-wrap a single string into lines no wider than `width`.
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur.length) {
      cur = w;
    } else if (cur.length + 1 + w.length <= width) {
      cur += " " + w;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur.length) lines.push(cur);
  return lines;
}

// Build the speech bubble box around a list of lines.
function bubble(lines: string[]): string {
  const w = Math.max(...lines.map((l) => l.length));
  const padded = lines.map((l) => l.padEnd(w, " "));
  if (lines.length === 1) {
    return ` ${"_".repeat(w + 2)}\n< ${padded[0]} >\n ${"-".repeat(w + 2)}`;
  }
  const top = ` ${"_".repeat(w + 2)}`;
  const bot = ` ${"-".repeat(w + 2)}`;
  const middle = padded.map((l, i) => {
    const left = i === 0 ? "/" : i === lines.length - 1 ? "\\" : "|";
    const right = i === 0 ? "\\" : i === lines.length - 1 ? "/" : "|";
    return `${left} ${l} ${right}`;
  });
  return [top, ...middle, bot].join("\n");
}

export default defineTool({
  description:
    "Render a cowsay-style ASCII cow saying the given text. Useful for fun, " +
    "demos, or when a user asks for `cowsay`. No binary dependency.",
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .describe("What the cow should say. Word-wrapped at 40 chars."),
  }),
  async execute({ text }) {
    const lines = wrap(text, 40);
    return { cow: `${bubble(lines)}\n${COW}` };
  },
});