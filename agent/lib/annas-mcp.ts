/**
 * Wrapper around the unofficial annas-mcp CLI
 * (https://github.com/iosifache/annas-mcp) for book/article search → MD5.
 *
 * Search does not require a membership key. Downloads use ANNA_API_KEY /
 * ANNAS_SECRET_KEY when calling book-download elsewhere.
 */
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATE_BINS = (): string[] => {
  const home = process.env.HOME ?? homedir();
  const fromEnv = process.env.ANNAS_MCP_BIN?.trim();
  return [
    ...(fromEnv ? [fromEnv] : []),
    join(home, ".local/bin/annas-mcp"),
    join(home, "bin/annas-mcp"),
    "/usr/local/bin/annas-mcp",
    "annas-mcp", // PATH
  ];
};

export function resolveAnnasMcpBin(): string {
  for (const p of CANDIDATE_BINS()) {
    if (p === "annas-mcp") return p;
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* try next */
    }
  }
  return "annas-mcp";
}

export type AnnasMcpHit = {
  index: number;
  title: string | null;
  authors: string | null;
  publisher: string | null;
  language: string | null;
  format: string | null;
  size: string | null;
  url: string | null;
  md5: string | null;
};

export type AnnasMcpResult = {
  ok: boolean;
  bin: string;
  command: string[];
  hits: AnnasMcpHit[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
};

function cleanStderr(s: string): string {
  return s
    .split("\n")
    .filter((l) => !/Error loading \.env file/i.test(l))
    .filter((l) => !/^github\.com\//.test(l))
    .filter((l) => !/^\/home\/runner\//.test(l))
    .filter((l) => !/^\/opt\/hostedtoolcache\//.test(l))
    .filter((l) => !/^runtime\./.test(l))
    .filter((l) => !/^main\./.test(l))
    .join("\n")
    .trim();
}

function parseHits(stdout: string, kind: "Book" | "Article"): AnnasMcpHit[] {
  const blocks = stdout.split(new RegExp(`(?=${kind} \\d+:)`)).filter(Boolean);
  const hits: AnnasMcpHit[] = [];
  for (const block of blocks) {
    const mIdx = block.match(new RegExp(`^${kind} (\\d+):`));
    if (!mIdx) continue;
    const field = (name: string) => {
      const re = new RegExp(`^${name}:\\s*(.*)$`, "im");
      const m = block.match(re);
      const v = m?.[1]?.trim() ?? "";
      return v.length ? v : null;
    };
    const hash = field("Hash");
    const url = field("URL");
    let md5 = hash;
    if (!md5 && url) {
      const um = url.match(/\/md5\/([a-f0-9]{32})/i);
      if (um) md5 = um[1]!.toLowerCase();
    }
    if (md5) md5 = md5.toLowerCase();
    hits.push({
      index: Number(mIdx[1]),
      title: field("Title"),
      authors: field("Authors"),
      publisher: field("Publisher"),
      language: field("Language"),
      format: field("Format"),
      size: field("Size"),
      url,
      md5,
    });
  }
  return hits;
}

export async function runAnnasMcp(
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<AnnasMcpResult> {
  const bin = resolveAnnasMcpBin();
  const env = { ...process.env };
  // Map OpenBao key into the name annas-mcp expects for downloads.
  if (!env.ANNAS_SECRET_KEY && env.ANNA_API_KEY) {
    env.ANNAS_SECRET_KEY = env.ANNA_API_KEY;
  }
  if (!env.ANNAS_BASE_URL && env.ANNA_ARCHIVE_BASE) {
    env.ANNAS_BASE_URL = env.ANNA_ARCHIVE_BASE.replace(/^https?:\/\//, "");
  }

  const child = spawn(bin, args, {
    cwd: opts.cwd ?? process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (c: string) => {
    stdout += c;
  });
  child.stderr?.on("data", (c: string) => {
    stderr += c;
  });

  const timeoutMs = opts.timeoutMs ?? 90_000;
  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      const t = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`annas-mcp timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(t);
        resolve(code);
      });
    });
  } catch (e) {
    return {
      ok: false,
      bin,
      command: [bin, ...args],
      hits: [],
      stdout,
      stderr,
      exitCode: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const isArticle = args[0] === "article-search";
  const hits = parseHits(stdout, isArticle ? "Article" : "Book");
  const errText = cleanStderr(stderr);
  const notFound =
    /not found|command not found|ENOENT/i.test(stderr) ||
    (exitCode === null && hits.length === 0);

  return {
    ok: hits.length > 0,
    bin,
    command: [bin, ...args],
    hits,
    stdout,
    stderr: errText,
    exitCode,
    error: notFound
      ? `annas-mcp binary not usable (${bin}). Install: scripts/install-annas-mcp.sh`
      : hits.length === 0
        ? `annas-mcp returned no hits (exit ${exitCode})`
        : undefined,
  };
}

export async function annasBookSearch(
  query: string,
  opts?: { timeoutMs?: number; limit?: number },
): Promise<AnnasMcpResult> {
  const result = await runAnnasMcp(["book-search", query], {
    timeoutMs: opts?.timeoutMs ?? 90_000,
  });
  if (opts?.limit && opts.limit > 0) {
    result.hits = result.hits.slice(0, opts.limit);
  }
  return result;
}

export async function annasArticleSearch(
  query: string,
  opts?: { timeoutMs?: number; limit?: number },
): Promise<AnnasMcpResult> {
  const result = await runAnnasMcp(["article-search", query], {
    timeoutMs: opts?.timeoutMs ?? 90_000,
  });
  if (opts?.limit && opts.limit > 0) {
    result.hits = result.hits.slice(0, opts.limit);
  }
  return result;
}
