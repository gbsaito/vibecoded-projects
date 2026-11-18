import { connect } from "node:http2";

export class HttpError extends Error {
  readonly kind: "network" | "timeout" | "rate-limit" | "status" | "parse" | "aborted";
  readonly status?: number;

  constructor(
    message: string,
    kind: "network" | "timeout" | "rate-limit" | "status" | "parse" | "aborted",
    status?: number,
  ) {
    super(message);
    this.name = "HttpError";
    this.kind = kind;
    this.status = status;
  }
}

export function isAbort(e: unknown): boolean {
  return e instanceof HttpError && e.kind === "aborted";
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface FetchOpts {
  signal?: AbortSignal;
  timeoutMs: number;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  attempts?: number;
  /** Response type requested from the server. Defaults to JSON. */
  accept?: string;
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

/**
 * Fetch a response body with a timeout, bounded retries and exponential
 * backoff. Endpoints behind an edge that rejects Node's HTTP/1.1 client use
 * {@link fetchJsonHttp2} instead.
 */
async function fetchBody(url: string, opts: FetchOpts): Promise<string> {
  const attempts = opts.attempts ?? 2;
  let last: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) throw new HttpError("aborted", "aborted");

    const { signal, cleanup } = withTimeout(opts);
    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        body: opts.body,
        signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: opts.accept ?? "application/json",
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
          ...opts.headers,
        },
      });

      if (res.ok) return await res.text();

      if (res.status === 429) {
        last = new HttpError("rate limited", "rate-limit", 429);
        if (attempt + 1 < attempts) {
          await sleep(1200 * (attempt + 1), opts.signal);
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
      if (e instanceof HttpError) throw e;
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

/** Fetch and parse JSON. */
export async function fetchJson<T>(url: string, opts: FetchOpts): Promise<T> {
  const text = await fetchBody(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new HttpError(`bad JSON from ${url}: ${(e as Error).message}`, "parse");
  }
}

/** Fetch an HTML/text document (Metacritic's game pages, for example). */
export function fetchText(url: string, opts: FetchOpts): Promise<string> {
  return fetchBody(url, { ...opts, accept: opts.accept ?? "text/html,application/xhtml+xml" });
}

export interface FetchJsonHttp2Opts {
  signal?: AbortSignal;
  timeoutMs: number;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  attempts?: number;
}

/**
 * A single HTTP/2 request. Some storefront edges (Epic's Cloudflare front)
 * answer Node's HTTP/1.1 client with a challenge page while serving the same
 * request over HTTP/2, so those endpoints need this transport instead.
 */
function http2Text(url: string, opts: FetchJsonHttp2Opts): Promise<string> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    let settled = false;
    let session: ReturnType<typeof connect> | null = null;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      try {
        session?.close();
      } catch {
        /* the session may already be gone */
      }
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => finish(() => reject(new HttpError("aborted", "aborted")));

    try {
      session = connect(target.origin);
    } catch (e) {
      finish(() => reject(new HttpError(`network error: ${(e as Error).message}`, "network")));
      return;
    }

    timer = setTimeout(
      () => finish(() => reject(new HttpError(`no response within ${opts.timeoutMs}ms`, "timeout"))),
      opts.timeoutMs,
    );
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    session.on("error", (e) =>
      finish(() => reject(new HttpError(`network error: ${e.message}`, "network"))),
    );

    let req;
    try {
      req = session.request({
        ":method": opts.method ?? "GET",
        ":path": target.pathname + target.search,
        ":authority": target.host,
        "user-agent": USER_AGENT,
        accept: "application/json",
        ...(opts.body ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      });
    } catch (e) {
      finish(() => reject(new HttpError(`network error: ${(e as Error).message}`, "network")));
      return;
    }

    let status = 0;
    let body = "";
    req.setEncoding("utf8");
    req.on("response", (headers) => {
      status = Number(headers[":status"]);
    });
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      if (status >= 200 && status < 300) finish(() => resolve(body));
      else
        finish(() =>
          reject(
            new HttpError(
              `HTTP ${status}`,
              status === 429 ? "rate-limit" : "status",
              status,
            ),
          ),
        );
    });
    req.on("error", (e) =>
      finish(() => reject(new HttpError(`network error: ${e.message}`, "network"))),
    );
    req.end(opts.body);
  });
}

/** Fetch JSON over HTTP/2. Same retry shape as {@link fetchJson}. */
export async function fetchJsonHttp2<T>(url: string, opts: FetchJsonHttp2Opts): Promise<T> {
  const attempts = opts.attempts ?? 2;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) throw new HttpError("aborted", "aborted");
    try {
      const text = await http2Text(url, opts);
      try {
        return JSON.parse(text) as T;
      } catch (e) {
        throw new HttpError(`bad JSON from ${url}: ${(e as Error).message}`, "parse");
      }
    } catch (e) {
      if (!(e instanceof HttpError)) {
        if (attempt + 1 < attempts) {
          await sleep(300 * 2 ** attempt, opts.signal);
          continue;
        }
        throw new HttpError(`network error: ${(e as Error).message}`, "network");
      }
      // Retry only transient failures; a 4xx (e.g. a challenge page) is final.
      const transient =
        e.kind === "rate-limit" || (e.kind === "status" && (e.status ?? 0) >= 500);
      if (transient && attempt + 1 < attempts) {
        await sleep(e.kind === "rate-limit" ? 1200 * (attempt + 1) : 400 * 2 ** attempt, opts.signal);
        continue;
      }
      throw e;
    }
  }
  throw new HttpError("request failed", "network");
}
