/**
 * Durable plain-text "memory bank" on the host filesystem (not the sandbox).
 * Default: $HOME/memory-bank.txt — override with MEMORY_BANK_PATH.
 */
import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";

export function memoryBankPath(): string {
  const fromEnv = process.env.MEMORY_BANK_PATH?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(homedir(), "memory-bank.txt");
}

export type MemoryBankEntry = {
  /** ISO-8601 when saved */
  at: string;
  /** IRC nick / who asked, if known */
  by: string | null;
  /** Free-form line (usually "Artist - Title") */
  text: string;
  /** Raw file line as stored */
  line: string;
};

function formatLine(opts: {
  text: string;
  by?: string | null;
  at?: string;
}): string {
  const at = opts.at ?? new Date().toISOString();
  const by = opts.by?.trim() || "-";
  const text = opts.text.replace(/\s+/g, " ").trim();
  // pipe-separated so list/parse stays simple; text may contain spaces
  return `${at} | ${by} | ${text}`;
}

export function parseMemoryBankLine(line: string): MemoryBankEntry | null {
  const raw = line.trim();
  if (!raw || raw.startsWith("#")) return null;
  const parts = raw.split(" | ");
  if (parts.length >= 3) {
    const [at, by, ...rest] = parts;
    const text = rest.join(" | ").trim();
    return {
      at: at.trim(),
      by: by.trim() === "-" ? null : by.trim(),
      text,
      line: raw,
    };
  }
  // legacy / free-form one-liners
  return { at: "", by: null, text: raw, line: raw };
}

async function ensureParentDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
}

export async function memoryBankExists(
  filePath = memoryBankPath(),
): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function appendMemoryBank(opts: {
  text: string;
  by?: string | null;
  path?: string;
}): Promise<{ path: string; line: string; entryCount: number; created: boolean }> {
  const text = opts.text.replace(/\s+/g, " ").trim();
  if (!text) throw new Error("memory bank entry text is empty");

  const filePath = opts.path ?? memoryBankPath();
  const created = !(await memoryBankExists(filePath));
  await ensureParentDir(filePath);

  const line = formatLine({ text, by: opts.by });
  await appendFile(filePath, `${line}\n`, "utf8");

  const entries = await listMemoryBank({ path: filePath });
  return {
    path: filePath,
    line,
    entryCount: entries.length,
    created,
  };
}

export async function listMemoryBank(opts?: {
  path?: string;
  limit?: number;
}): Promise<MemoryBankEntry[]> {
  const filePath = opts?.path ?? memoryBankPath();
  if (!(await memoryBankExists(filePath))) return [];

  const raw = await readFile(filePath, "utf8");
  const entries: MemoryBankEntry[] = [];
  for (const line of raw.split("\n")) {
    const e = parseMemoryBankLine(line);
    if (e) entries.push(e);
  }

  const limit = opts?.limit;
  if (limit != null && limit > 0 && entries.length > limit) {
    return entries.slice(-limit);
  }
  return entries;
}
