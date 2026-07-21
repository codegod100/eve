/**
 * Thin wrapper around the @solpbc/rook CLI (JSON mode).
 * See https://rook.host/llms.txt
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

function resolveRookBin(): string {
  try {
    const pkgJson = require.resolve("@solpbc/rook/package.json");
    return join(dirname(pkgJson), "bin", "rook.js");
  } catch {
    // Fall back to PATH / npx when the package isn't installed next to the agent.
    return "rook";
  }
}

export type RookCliResult = {
  ok: boolean;
  /** Parsed JSON stdout when the CLI emitted JSON. */
  data: unknown;
  /** Raw stdout if JSON parse failed. */
  stdout: string;
  /** stderr (progress + diagnostics). */
  stderr: string;
  exitCode: number | null;
};

/**
 * Run `rook <args…> --json`. Optional identity path via arg or ROOK_IDENTITY_FILE.
 */
export async function runRook(
  args: string[],
  opts: {
    cwd?: string;
    identity?: string;
    timeoutMs?: number;
  } = {},
): Promise<RookCliResult> {
  const bin = resolveRookBin();
  const identity = opts.identity ?? process.env.ROOK_IDENTITY_FILE;
  const fullArgs = [
    ...(identity ? ["--identity", identity] : []),
    ...args,
    // Commands already taking --json are fine; force JSON for structured tools.
    ...(args.includes("--json") ? [] : ["--json"]),
  ];

  const isJs = bin.endsWith(".js");
  const child = spawn(
    isJs ? process.execPath : bin,
    isJs ? [bin, ...fullArgs] : fullArgs,
    {
      cwd: opts.cwd ?? process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

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

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const t = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(`rook timed out after ${timeoutMs}ms: ${fullArgs.join(" ")}`),
      );
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

  let data: unknown = null;
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      data = JSON.parse(trimmed);
    } catch {
      data = null;
    }
  }

  const okFromJson =
    data !== null &&
    typeof data === "object" &&
    data !== null &&
    "ok" in data &&
    typeof (data as { ok: unknown }).ok === "boolean"
      ? (data as { ok: boolean }).ok
      : exitCode === 0;

  return {
    ok: okFromJson && exitCode === 0,
    data: data ?? (trimmed || null),
    stdout: trimmed,
    stderr: stderr.trim(),
    exitCode,
  };
}
