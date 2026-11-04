// Small in-browser cache for chart data requests.
// - Identical requests made at the same time share one network call
//   (the execution chart and the replay both ask for the same order levels).
// - Results are reused for CACHE_MS, so reopening a row is instant.
// - prefetchJson() warms the cache when the user hovers a row, before the click.

const CACHE_MS = 60_000;
const MAX_ENTRIES = 80;

type Stored = { status: number; headers: [string, string][]; body: ArrayBuffer };
const store = new Map<string, { at: number; promise: Promise<Stored> }>();

function cacheKey(input: string) {
  try {
    const url = new URL(input, typeof window === "undefined" ? "http://local" : window.location.origin);
    url.searchParams.sort();
    return url.pathname + "?" + url.searchParams.toString();
  } catch {
    return input;
  }
}

function load(url: string): Promise<Stored> {
  const key = cacheKey(url);
  const now = Date.now();
  const hit = store.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.promise;
  const promise = fetch(url, { cache: "no-store" }).then(async (r) => ({
    status: r.status,
    headers: [...r.headers.entries()],
    body: await r.arrayBuffer(),
  }));
  store.set(key, { at: now, promise });
  promise.then(
    (v) => { if (v.status >= 400) store.delete(key); },
    () => store.delete(key),
  );
  if (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  return promise;
}

/** Drop-in for fetch(url, { signal }) on GET chart endpoints. */
export function cachedFetch(url: string, init?: { signal?: AbortSignal | null; cache?: RequestCache }): Promise<Response> {
  const signal = init?.signal ?? null;
  const toResponse = (v: Stored) =>
    new Response(v.status === 204 || v.status === 304 ? null : v.body.slice(0), { status: v.status, headers: v.headers });
  const result = load(url).then(toResponse);
  if (!signal) return result;
  return new Promise((resolve, reject) => {
    const abortError = () => new DOMException("Aborted", "AbortError");
    if (signal.aborted) { reject(abortError()); return; }
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
    result.then(resolve, reject);
  });
}

/** Warm the cache (e.g. on row hover). Errors are ignored. */
export function prefetchJson(url: string) {
  void load(url).catch(() => undefined);
}
