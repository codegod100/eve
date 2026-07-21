/** Public thermals.cloud appview helpers (no auth). */

export function thermalsBase(): string {
  return (process.env.THERMALS_URL ?? "https://thermals.cloud").replace(/\/$/, "");
}

export async function thermalsGet<T>(
  path: string,
  query: Record<string, string | number | undefined> = {},
  timeoutMs = 15_000,
): Promise<T> {
  const url = new URL(path.startsWith("http") ? path : `${thermalsBase()}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      detail = body.message ?? body.error ?? detail;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(`thermals ${url.pathname} failed (${res.status}): ${detail}`);
  }

  return (await res.json()) as T;
}
