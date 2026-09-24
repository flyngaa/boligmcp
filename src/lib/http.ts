import { VERSION } from "../version.js";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface FetchJsonOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  accept?: string;
}

const DEFAULT_UA = `boligmcp/${VERSION} (https://github.com/flyngaa/boligmcp)`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchText(
  url: string,
  options: FetchJsonOptions = {},
): Promise<string> {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 20_000,
    retries = 2,
    accept,
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "user-agent": DEFAULT_UA,
          accept: accept ?? "application/json, application/xml, text/xml, */*",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        const safeUrl = url.replace(/apiKey=[^&]+/gi, "apiKey=REDACTED");
        throw new HttpError(
          `HTTP ${response.status} from ${safeUrl}: ${text.slice(0, 400)}`,
          response.status,
          safeUrl,
        );
      }
      return text;
    } catch (error) {
      lastError = error;
      const status = error instanceof HttpError ? error.status : undefined;
      const retryable =
        status === undefined || status >= 500 || status === 429;
      if (!retryable || attempt === retries) break;
      await sleep(400 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function fetchJson<T>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<T> {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(`Invalid JSON from ${url}: ${text.slice(0, 200)}`, undefined, url);
  }
}
