import { AssetError } from "../error";
import type { AssetErrorContext } from "../error";

/** Injectable delay seam; tests and hosts can avoid real timers. */
export type RetrySleep = (delayMs: number, signal?: AbortSignal) => Promise<void>;

/** The side-effect profile of the request being dispatched. */
export type AssetRetryOperation = "discovery" | "generation";

export interface AssetRetryOptions {
  /**
   * Discovery defaults to bounded transient retries; chargeable generation defaults to no replay.
   * Providers must set this explicitly instead of inferring it from an HTTP method.
   */
  readonly operation?: AssetRetryOperation;
  /**
   * Explicit transient statuses to replay. Values outside 429 and 5xx are ignored. Omitting this
   * never replays; discovery callers must explicitly set `operation: "discovery"`.
   */
  readonly retryStatuses?: readonly number[];
  /** Retries after the initial dispatch. Defaults to 2. */
  readonly maxRetries?: number;
  /** Initial exponential-backoff delay in milliseconds. Defaults to 250 ms. */
  readonly baseDelayMs?: number;
  /** Upper bound for a valid Retry-After delay. Defaults to 30 seconds. */
  readonly maxRetryAfterMs?: number;
  /** Injectable clock used only to parse HTTP-date Retry-After values. */
  readonly now?: () => number;
  /** Injectable timer used to keep provider tests hermetic. */
  readonly sleep?: RetrySleep;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;

/**
 * Dispatches an injected fetch with conservative retries for explicitly transient outcomes only.
 * It never exposes a transport exception or a response body: callers receive a Response or a
 * redacted AssetError suitable for host/UI propagation.
 */
export async function retryAssetFetch(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  options: AssetRetryOptions = {},
): Promise<Response> {
  const maxRetries = boundedNonNegativeInteger(options.maxRetries, DEFAULT_MAX_RETRIES);
  const baseDelayMs = boundedNonNegativeInteger(options.baseDelayMs, DEFAULT_BASE_DELAY_MS);
  const maxRetryAfterMs = boundedNonNegativeInteger(options.maxRetryAfterMs, DEFAULT_MAX_RETRY_AFTER_MS);
  const signal = init.signal ?? undefined;
  const shouldRetryStatus = retryStatusPolicy(options);

  if (signal?.aborted) throw new AssetError("request-aborted", { mayHaveCharged: false });

  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      if (isAbort(error) || signal?.aborted) {
        // A dispatch was attempted, so the remote side may already have accepted it.
        throw new AssetError("request-aborted", { mayHaveCharged: true });
      }
      // A transport error follows a dispatched request. Its billing/result state is ambiguous,
      // so replaying it could create a duplicate charged asset.
      throw new AssetError("network-failure", { mayHaveCharged: true });
    }

    if (!shouldRetryStatus(response.status) || attempt >= maxRetries) return response;

    const delay = retryDelayMs(response.headers.get("retry-after"), {
      fallbackMs: baseDelayMs * 2 ** attempt,
      maxRetryAfterMs,
      now: options.now,
    });
    await waitBeforeRetry(delay, signal, options.sleep);
    if (signal?.aborted) throw new AssetError("request-aborted", { mayHaveCharged: true });
    attempt += 1;
  }
}

/** 429 and server failures are the only HTTP outcomes this helper may replay. */
export function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Parses the standard Retry-After forms. Invalid values deliberately use fallback backoff; valid
 * values are capped so a hostile/intermediate response cannot stall asset generation indefinitely.
 */
export function retryDelayMs(
  retryAfter: string | null,
  options: { readonly fallbackMs: number; readonly maxRetryAfterMs?: number; readonly now?: () => number },
): number {
  const fallbackMs = boundedNonNegativeInteger(options.fallbackMs, 0);
  const maxMs = boundedNonNegativeInteger(options.maxRetryAfterMs, DEFAULT_MAX_RETRY_AFTER_MS);
  if (retryAfter === null) return fallbackMs;

  const value = retryAfter.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (Number.isSafeInteger(seconds)) return Math.min(seconds * 1_000, maxMs);
  }

  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    const delay = Math.max(0, timestamp - (options.now?.() ?? Date.now()));
    return Math.min(delay, maxMs);
  }
  return fallbackMs;
}

/** Maps a provider HTTP response to a safe typed error without retaining its body. */
export async function assetErrorFromResponse(
  response: Response,
  context: AssetErrorContext | undefined,
): Promise<AssetError> {
  if (response.status === 401) return new AssetError("authentication-failed", { context });
  if (response.status === 403) return new AssetError("authorization-failed", { context });
  if (response.status === 429) return new AssetError("rate-limited", { context });

  if (response.status >= 400 && response.status < 500) {
    if (await responseSignalsContentRejection(response))
      return new AssetError("content-rejected", { context });
    return new AssetError("invalid-request", { context });
  }

  return new AssetError("provider-failure", { context, mayHaveCharged: true });
}

async function responseSignalsContentRejection(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.json();
    return containsContentRejectionMarker(body);
  } catch {
    return false;
  }
}

function containsContentRejectionMarker(value: unknown): boolean {
  if (typeof value === "string")
    return /(?:content[ _-]?(?:policy|filter)|moderation|safety)[ _-]?(?:violation|blocked|rejected|filter)?/i.test(
      value,
    );
  if (Array.isArray(value)) return value.some(containsContentRejectionMarker);
  if (value === null || typeof value !== "object") return false;

  for (const [key, nested] of Object.entries(value)) {
    if ((key === "code" || key === "type") && containsContentRejectionMarker(nested)) return true;
    if (containsContentRejectionMarker(nested)) return true;
  }
  return false;
}

async function waitBeforeRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
  sleep: RetrySleep | undefined,
): Promise<void> {
  const delay = Math.max(0, delayMs);
  if (sleep) {
    await sleep(delay, signal);
    return;
  }
  if (delay === 0 || signal?.aborted) return;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delay);
    const onAbort = (): void => {
      clearTimeout(timer);
      done();
    };
    function done(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
const NEVER_RETRY_STATUS = (_status: number): boolean => false;

function retryStatusPolicy(options: AssetRetryOptions): (status: number) => boolean {
  if (options.retryStatuses === undefined) {
    return options.operation === "discovery" ? isTransientStatus : NEVER_RETRY_STATUS;
  }

  const statuses = new Set(options.retryStatuses.filter(isTransientStatus));
  return (status) => statuses.has(status);
}

function boundedNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) return fallback;
  return value;
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
