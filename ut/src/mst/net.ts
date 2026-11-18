export class HttpError extends Error {
  readonly kind: "network" | "timeout" | "rate-limit" | "status" | "parse" | "aborted";
  readonly status?: number;
  readonly retryAt?: number;

  constructor(
    message: string,
    kind: "network" | "timeout" | "rate-limit" | "status" | "parse" | "aborted",
    status?: number,
    retryAt?: number,
  ) {
    super(message);
    this.name = "HttpError";
    this.kind = kind;
    this.status = status;
    this.retryAt = retryAt;
  }
}

export function isAbort(e: unknown): boolean {
  return e instanceof HttpError && e.kind === "aborted";
}

const USER_AGENT = "mtrack-ts/0.1 (+opentui)";

export interface FetchOpts {
  signal?: AbortSignal;
  timeoutMs: number;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  attempts?: number;
}

function withTimeout(opts: FetchOpts): {
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  const ctl = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, opts.timeoutMs);

  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  return {
    signal: ctl.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    },
  };
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new HttpError("aborted", "aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(new HttpError("aborted", "aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export function parseRateLimit(res: Response): { remaining: number; retryAt: number } | null {
  const remaining = Number(res.headers.get("x-ratelimit-remaining"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (!Number.isFinite(remaining) || !Number.isFinite(reset) || reset <= 0) return null;
  return { remaining, retryAt: reset * 1000 };
}

export async function fetchJson<T>(url: string, opts: FetchOpts): Promise<T> {
  const attempts = opts.attempts ?? 2;
  let last: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) throw new HttpError("aborted", "aborted");

    const { signal, cleanup, timedOut } = withTimeout(opts);
    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        body: opts.body,
        signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
          ...opts.headers,
        },
      });

      if (res.ok) {
        const text = await res.text();
        try {
          return JSON.parse(text) as T;
        } catch (e) {
          throw new HttpError(`bad JSON from ${url}: ${(e as Error).message}`, "parse");
        }
      }

      const rl = parseRateLimit(res);

      if (res.status === 429) {
        const wait = Math.min(
          rl ? Math.max(0, rl.retryAt - Date.now()) : 1200 * (attempt + 1),
          4000,
        );
        last = new HttpError("rate limited", "rate-limit", 429, Date.now() + wait);
        if (attempt + 1 < attempts) {
          await sleep(wait, opts.signal);
          continue;
        }
        throw last;
      }

      if (res.status >= 500) {
        last = new HttpError(`upstream ${res.status}`, "status", res.status);
        if (attempt + 1 < attempts) {
          await sleep(400 * 2 ** attempt, opts.signal);
          continue;
        }
        throw last;
      }

      throw new HttpError(`HTTP ${res.status}`, "status", res.status);
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.kind === "aborted") throw e;
        throw e;
      }
      const name = (e as Error)?.name;
      if (name === "AbortError") {
        if (opts.signal?.aborted) throw new HttpError("aborted", "aborted");
        throw new HttpError(`no response within ${opts.timeoutMs}ms`, "timeout");
      }
      last = new HttpError(`network error: ${(e as Error).message}`, "network");
      if (attempt + 1 < attempts) {
        await sleep(300 * 2 ** attempt, opts.signal);
        continue;
      }
      throw last;
    } finally {
      cleanup();
    }
  }
  throw last instanceof Error ? last : new HttpError("request failed", "network");
}
